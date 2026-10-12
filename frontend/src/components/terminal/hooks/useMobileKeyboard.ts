import { useState, useRef, useCallback, useEffect } from 'react';
import { Terminal } from '@xterm/xterm';
import { calculateKeyboardTranslateY, shouldBlockPtyResize } from '../../../utils/mobileViewportHelper';
import { scrollToBottomSafe, isUserAtBottom } from '../../../utils/terminalScrollHelper';

export interface UseMobileKeyboardOptions {
  terminalContainerRef: React.RefObject<HTMLDivElement | null>;
  xtermRef: React.RefObject<Terminal | null>;
  isMountedRef: React.RefObject<boolean>;
  isMobile: boolean;
  standalone: boolean;
  hideHeader?: boolean;
  headerRef: React.RefObject<HTMLDivElement | null>;
  fontSize: number;
  safeFit: (force?: boolean) => boolean;
}

export interface UseMobileKeyboardReturn {
  isKeyboardOpen: boolean;
  setIsKeyboardOpen: (open: boolean) => void;
  viewportStyle: React.CSSProperties;
  cursorShiftY: number;
  setCursorShiftY: (y: number) => void;
  cursorShiftYRef: React.MutableRefObject<number>;
  baseHeightRef: React.MutableRefObject<number>;
  baseWidthRef: React.MutableRefObject<number>;
  isKeyboardShowingRef: React.MutableRefObject<boolean>;
  updateCursorShift: () => void;
  handleHideKeyboard: () => void;
  handleToggleKeyboard: () => void;
}

export function useMobileKeyboard({
  terminalContainerRef,
  xtermRef,
  isMountedRef,
  isMobile,
  standalone,
  hideHeader,
  headerRef,
  fontSize,
  safeFit,
}: UseMobileKeyboardOptions): UseMobileKeyboardReturn {
  const [isKeyboardOpen, setIsKeyboardOpen] = useState<boolean>(false);
  const [viewportStyle, setViewportStyle] = useState<React.CSSProperties>({});
  const [cursorShiftY, setCursorShiftY] = useState<number>(0);

  const cursorShiftYRef = useRef<number>(0);
  const baseHeightRef = useRef<number>(typeof window !== 'undefined' ? window.innerHeight : 0);
  const baseWidthRef = useRef<number>(typeof window !== 'undefined' ? window.innerWidth : 0);
  const isKeyboardShowingRef = useRef<boolean>(false);
  const fontSizeRef = useRef<number>(fontSize);
  fontSizeRef.current = fontSize;

  useEffect(() => {
    if (typeof window !== 'undefined') {
      baseHeightRef.current = Math.max(baseHeightRef.current, window.innerHeight);
      baseWidthRef.current = window.innerWidth;
    }
  }, [standalone]);

  const updateViewport = useCallback(() => {
    if (!isMountedRef.current) return;
    const textarea = terminalContainerRef.current?.querySelector('textarea');
    const isInputFocused = document.activeElement === textarea;

    const offsetResult = calculateKeyboardTranslateY({
      baseHeight: baseHeightRef.current,
      viewportHeight: typeof window !== 'undefined' && window.visualViewport ? window.visualViewport.height : (typeof window !== 'undefined' ? window.innerHeight : 0),
      isInputFocused,
    });

    const wasKeyboardShowing = isKeyboardShowingRef.current;
    const isKeyboardShowing = offsetResult.isKeyboardShowing;
    isKeyboardShowingRef.current = isKeyboardShowing;
    setIsKeyboardOpen(isKeyboardShowing);

    if (wasKeyboardShowing && !isKeyboardShowing) {
      if (xtermRef.current) {
        scrollToBottomSafe(xtermRef.current);
      }
      if (typeof window !== 'undefined' && window.scrollY !== 0) {
        window.scrollTo(0, 0);
      }
    }

    if (isMobile && standalone) {
      if (offsetResult.translateY > 0) {
        setViewportStyle({
          transform: `translateY(-${offsetResult.translateY}px)`,
          transition: 'none',
        });
      } else {
        setViewportStyle({});
      }
    } else {
      setViewportStyle({});
    }
  }, [isMobile, standalone, isMountedRef, terminalContainerRef, xtermRef]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const vv = window.visualViewport;
    if (vv) {
      vv.addEventListener('resize', updateViewport);
      vv.addEventListener('scroll', updateViewport);
    }
    window.addEventListener('resize', updateViewport);
    window.addEventListener('orientationchange', updateViewport);
    return () => {
      if (vv) {
        vv.removeEventListener('resize', updateViewport);
        vv.removeEventListener('scroll', updateViewport);
      }
      window.removeEventListener('resize', updateViewport);
      window.removeEventListener('orientationchange', updateViewport);
    };
  }, [updateViewport]);

  const handleHideKeyboard = useCallback(() => {
    const textarea = terminalContainerRef.current?.querySelector('textarea');
    if (textarea) {
      textarea.blur();
    }
    (document.activeElement as HTMLElement)?.blur();
    setIsKeyboardOpen(false);
    isKeyboardShowingRef.current = false;
    cursorShiftYRef.current = 0;
    setCursorShiftY(0);

    // Multi-phase scroll reset for iOS Safari (immediate + 100ms + 320ms)
    if (typeof window !== 'undefined') {
      if (window.scrollY !== 0) {
        window.scrollTo(0, 0);
      }
      setTimeout(() => {
        if (typeof window !== 'undefined' && window.scrollY !== 0) {
          window.scrollTo(0, 0);
        }
      }, 100);
      setTimeout(() => {
        if (typeof window !== 'undefined' && window.scrollY !== 0) {
          window.scrollTo(0, 0);
        }
      }, 320);
    }

    if (xtermRef.current) {
      scrollToBottomSafe(xtermRef.current);
      setTimeout(() => {
        if (xtermRef.current) {
          scrollToBottomSafe(xtermRef.current);
        }
      }, 100);
      setTimeout(() => {
        if (xtermRef.current) {
          scrollToBottomSafe(xtermRef.current);
        }
      }, 320);
    }

    const isWidthStable = Math.abs(window.innerWidth - baseWidthRef.current) <= 20;
    if (!isMobile || !standalone || !isWidthStable) {
      setTimeout(() => {
        if (isMountedRef.current) {
          safeFit(true);
        }
      }, 260);
    }
  }, [isMobile, standalone, isMountedRef, safeFit, terminalContainerRef, xtermRef]);

  const updateCursorShift = useCallback(() => {
    if (!isMountedRef.current || !xtermRef.current || !terminalContainerRef.current) return;
    const term = xtermRef.current;
    const container = terminalContainerRef.current;

    const isMobileDevice =
      isMobile ||
      (typeof window !== 'undefined' &&
        (window.innerWidth < 768 || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)));
    const isKeyboardActive =
      isKeyboardShowingRef.current ||
      isKeyboardOpen ||
      (isMobileDevice &&
        typeof window !== 'undefined' &&
        window.visualViewport &&
        window.visualViewport.height < (baseHeightRef.current || window.innerHeight) * 0.85);

    if (!isMobileDevice || !isKeyboardActive) {
      if (cursorShiftYRef.current !== 0) {
        cursorShiftYRef.current = 0;
        setCursorShiftY(0);
      }
      return;
    }

    const actualCellHeight = (term as any)._core?._renderService?.dimensions?.actualCellHeight;
    const screenEl = (term as any).element?.querySelector('.xterm-screen') as HTMLElement | null;
    const cellHeight =
      (typeof actualCellHeight === 'number' && actualCellHeight > 0
        ? actualCellHeight
        : screenEl && term.rows > 0
        ? screenEl.clientHeight / term.rows
        : 0) || Math.max(12, fontSizeRef.current * 1.3);

    const totalScreenHeight = screenEl?.clientHeight || term.rows * cellHeight;

    let visibleHeight = container.parentElement?.clientHeight || container.clientHeight;
    if (typeof window !== 'undefined' && window.visualViewport) {
      const estimatedVisible = Math.max(100, window.visualViewport.height - 44 - 44 - 16);
      if (visibleHeight > estimatedVisible && isKeyboardActive) {
        visibleHeight = estimatedVisible;
      }
    }

    if (visibleHeight <= 0 || totalScreenHeight <= visibleHeight) {
      if (cursorShiftYRef.current !== 0) {
        cursorShiftYRef.current = 0;
        setCursorShiftY(0);
      }
      return;
    }

    const cursorY = term.buffer?.active?.cursorY ?? term.rows - 1;
    const cursorBottom = (cursorY + 1) * cellHeight;

    if (cursorBottom <= visibleHeight) {
      if (cursorShiftYRef.current !== 0) {
        cursorShiftYRef.current = 0;
        setCursorShiftY(0);
      }
      return;
    }

    const maxShift = Math.max(0, totalScreenHeight - visibleHeight);
    const targetShift = Math.max(0, cursorBottom - visibleHeight + 4);
    const shift = Math.min(maxShift, targetShift);
    const roundedShift = Math.round(shift);

    if (cursorShiftYRef.current !== roundedShift) {
      cursorShiftYRef.current = roundedShift;
      setCursorShiftY(roundedShift);
    }
  }, [isMobile, isKeyboardOpen, isMountedRef, terminalContainerRef, xtermRef]);

  const handleToggleKeyboard = useCallback(() => {
    const textarea = terminalContainerRef.current?.querySelector('textarea');
    if (isKeyboardOpen) {
      handleHideKeyboard();
    } else {
      if (isMobile && standalone) {
        isKeyboardShowingRef.current = true;
      }
      if (xtermRef.current) {
        xtermRef.current.focus();
        textarea?.focus({ preventScroll: true });
        if (isUserAtBottom(xtermRef.current)) {
          scrollToBottomSafe(xtermRef.current);
        }
      }
      setIsKeyboardOpen(true);
    }
  }, [isKeyboardOpen, isMobile, standalone, handleHideKeyboard, terminalContainerRef, xtermRef]);

  return {
    isKeyboardOpen,
    setIsKeyboardOpen,
    viewportStyle,
    cursorShiftY,
    setCursorShiftY,
    cursorShiftYRef,
    baseHeightRef,
    baseWidthRef,
    isKeyboardShowingRef,
    updateCursorShift,
    handleHideKeyboard,
    handleToggleKeyboard,
  };
}
