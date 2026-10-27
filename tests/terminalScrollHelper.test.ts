import {
  isUserAtBottom,
  shouldScrollToBottom,
  scrollToBottomSafe,
  stepTouchScrollLines,
  computeTouchVelocity,
  stepMomentumVelocity,
  applyViewportTouchScrollDelta,
  patchXtermNoopSelectionRefresh,
  flushXtermScrollFrameSync,
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

    it('computeTouchVelocity preserves velocity across short zero-delta lift-off samples and resets on direction reversal', () => {
      const vFast = computeTouchVelocity(0, 48, 16); // 3 px/ms
      expect(vFast).toBe(3);

      // Trailing lift-off sample with deltaY = 0 within 8ms must preserve velocity
      const vAfterLiftOffJitter = computeTouchVelocity(vFast, 0, 8);
      expect(vAfterLiftOffJitter).toBe(3);

      // Genuine hold (dtMs >= 40ms with deltaY = 0) decays velocity
      const vAfterHold = computeTouchVelocity(vFast, 0, 50);
      expect(vAfterHold).toBeLessThan(vFast);

      // Direction reversal immediately switches sign
      const vReversed = computeTouchVelocity(vFast, -32, 16);
      expect(vReversed).toBeLessThan(0);
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

    it('applyViewportTouchScrollDelta accumulates sub-line deltas into deterministic linesToScroll without snap-back loss', () => {
      const viewportEl = { scrollTop: 160, scrollHeight: 1600, clientHeight: 400 };

      // Frame 1: +6px (< 16px lineHeight) -> 0 lines, +6px remainder preserved
      const res1 = applyViewportTouchScrollDelta({
        viewportEl,
        deltaY: 6,
        lineHeight: 16,
        accumulatedDeltaY: 0,
      });
      expect(res1.linesToScroll).toBe(0);
      expect(res1.remainderDeltaY).toBe(6);
      expect(res1.subLineOffsetPx).toBe(0);
      expect(res1.hitBoundary).toBe(false);

      // Frame 2: +6px (total 12px < 16px) -> 0 lines, +12px remainder preserved even if xterm kept scrollTop at 160
      const res2 = applyViewportTouchScrollDelta({
        viewportEl,
        deltaY: 6,
        lineHeight: 16,
        accumulatedDeltaY: res1.remainderDeltaY,
      });
      expect(res2.linesToScroll).toBe(0);
      expect(res2.remainderDeltaY).toBe(12);

      // Frame 3: +6px (total 18px >= 16px) -> 1 line to scroll, +2px remainder preserved
      const res3 = applyViewportTouchScrollDelta({
        viewportEl,
        deltaY: 6,
        lineHeight: 16,
        accumulatedDeltaY: res2.remainderDeltaY,
      });
      expect(res3.linesToScroll).toBe(1);
      expect(res3.remainderDeltaY).toBe(2);
      expect(res3.hitBoundary).toBe(false);
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

    it('computeTouchVelocity preserves velocity on small same-direction lift-off micro-deltas (<= 2.5px)', () => {
      const vFast = computeTouchVelocity(0, 48, 16); // 3 px/ms
      expect(vFast).toBe(3);

      // Trailing 1.5px micro-delta during finger release within 12ms preserves velocity
      const vAfterMicroLift = computeTouchVelocity(vFast, 1.5, 12);
      expect(vAfterMicroLift).toBe(3);

      // Genuine slow drag after long interval (45ms) blends velocity downward
      const vSlowDrag = computeTouchVelocity(vFast, 1.5, 45);
      expect(vSlowDrag).toBeLessThan(vFast);
      expect(vSlowDrag).toBeGreaterThan(0);
    });

    it('applyViewportTouchScrollDelta skips DOM scrollTop mutation when syncViewportScrollTop is false', () => {
      let scrollTopWrites = 0;
      const viewportEl = {
        get scrollTop() {
          return 160;
        },
        set scrollTop(_v: number) {
          scrollTopWrites += 1;
        },
        scrollHeight: 1600,
        clientHeight: 400,
      };

      const res = applyViewportTouchScrollDelta({
        viewportEl,
        deltaY: 36,
        lineHeight: 16,
        accumulatedDeltaY: 0,
        syncViewportScrollTop: false,
      });

      expect(res.linesToScroll).toBe(2);
      expect(res.remainderDeltaY).toBe(4);
      expect(res.usedNativeScrollTop).toBe(false);
      expect(scrollTopWrites).toBe(0);
    });

    it('patchXtermNoopSelectionRefresh suppresses redundant empty selection redraws while preserving active and clear redraws', () => {
      const handleSelectionChanged = jest.fn();
      const mockTerm = {
        _core: {
          _renderService: {
            handleSelectionChanged,
          },
        },
      };

      patchXtermNoopSelectionRefresh(mockTerm);
      const rs = mockTerm._core._renderService;

      // 1. Repeated empty selection refreshes during scroll -> skipped!
      rs.handleSelectionChanged(undefined, undefined, false);
      rs.handleSelectionChanged(undefined, undefined, false);
      expect(handleSelectionChanged).toHaveBeenCalledTimes(0);

      // 2. Active selection -> forwarded!
      rs.handleSelectionChanged([0, 1], [5, 1], false);
      expect(handleSelectionChanged).toHaveBeenCalledTimes(1);

      // 3. Clearing active selection -> forwarded once to clear highlight!
      rs.handleSelectionChanged(undefined, undefined, false);
      expect(handleSelectionChanged).toHaveBeenCalledTimes(2);

      // 4. Subsequent empty selection refreshes -> skipped again!
      rs.handleSelectionChanged(undefined, undefined, false);
      expect(handleSelectionChanged).toHaveBeenCalledTimes(2);
    });

    it('flushXtermScrollFrameSync flushes RenderDebouncer and Viewport in the same animation frame', () => {
      const cancelRaf = jest.fn();
      const debouncerInnerRefresh = jest.fn();
      const viewportInnerRefresh = jest.fn();

      const mockTerm = {
        _core: {
          _coreBrowserService: {
            window: {
              cancelAnimationFrame: cancelRaf,
            },
          },
          _renderService: {
            _renderDebouncer: {
              _animationFrame: 42,
              _innerRefresh: debouncerInnerRefresh,
            },
          },
          viewport: {
            _refreshAnimationFrame: 99,
            _innerRefresh: viewportInnerRefresh,
          },
        },
      };

      flushXtermScrollFrameSync(mockTerm);

      expect(cancelRaf).toHaveBeenCalledWith(42);
      expect(cancelRaf).toHaveBeenCalledWith(99);
      expect(debouncerInnerRefresh).toHaveBeenCalledTimes(1);
      expect(viewportInnerRefresh).toHaveBeenCalledTimes(1);
      expect(mockTerm._core._renderService._renderDebouncer._animationFrame).toBeUndefined();
      expect(mockTerm._core.viewport._refreshAnimationFrame).toBeNull();
    });

    it('flushXtermScrollFrameSync runs viewport._innerRefresh before _renderDebouncer._innerRefresh to avoid layout thrashing', () => {
      const callOrder: string[] = [];
      const mockTerm = {
        _core: {
          _renderService: {
            _renderDebouncer: {
              _animationFrame: 11,
              _innerRefresh: () => callOrder.push('debouncer'),
            },
          },
          viewport: {
            _refreshAnimationFrame: 22,
            _innerRefresh: () => callOrder.push('viewport'),
          },
        },
      };

      flushXtermScrollFrameSync(mockTerm);
      expect(callOrder).toEqual(['viewport', 'debouncer']);
    });

    it('patchXtermNoopSelectionRefresh skips noop core.scrollLines(0, true, 1) from ignored viewport scroll events', () => {
      const origScrollLines = jest.fn();
      const mockTerm = {
        _core: {
          scrollLines: origScrollLines,
          _renderService: {
            handleSelectionChanged: jest.fn(),
          },
        },
      };

      patchXtermNoopSelectionRefresh(mockTerm);

      // Noop viewport scroll event (amount=0, source=1) -> skipped!
      mockTerm._core.scrollLines(0, true, 1);
      expect(origScrollLines).not.toHaveBeenCalled();

      // Real viewport scroll (amount=2, source=1) -> forwarded!
      mockTerm._core.scrollLines(2, true, 1);
      expect(origScrollLines).toHaveBeenCalledWith(2, true, 1);

      // Programmatic scrollLines (amount=0, source=0/undefined) -> forwarded!
      mockTerm._core.scrollLines(0, false);
      expect(origScrollLines).toHaveBeenCalledTimes(2);
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
