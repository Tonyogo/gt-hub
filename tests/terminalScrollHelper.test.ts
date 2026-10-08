import {
  isUserAtBottom,
  shouldScrollToBottom,
  scrollToBottomSafe,
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
});
