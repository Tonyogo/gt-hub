import React, { useEffect, useRef, useState, useCallback, useMemo, useImperativeHandle } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import {
  RefreshCw,
  Trash2,
  Maximize2,
  Minimize2,
  ZoomIn,
  ZoomOut,
  ArrowLeft,
  ArrowDown,
  TerminalSquare,
  FileText,
  Copy,
  Check,
  X,
  TextSelect,
  Plus
} from 'lucide-react';
import { useTranslation } from '../i18n/LanguageContext';
import { useTheme } from '../theme/ThemeContext';
import { TerminalAccessoryBar } from './terminal/TerminalAccessoryBar';
import { TerminalHostSelector } from './terminal/TerminalHostSelector';
import {
  isSyntheticTerminalReport,
  isUnsolicitedShellDeviceReport,
} from '../utils/terminalFilter';
import { encodeModifierKey } from '../utils/terminalKeyEncoder';
import {
  calculateKeyboardTranslateY,
  shouldBlockPtyResize,
} from '../utils/mobileViewportHelper';
import {
  isUserAtBottom,
  shouldScrollToBottom,
  scrollToBottomSafe,
} from '../utils/terminalScrollHelper';
import {
  calculateMagnifierPosition,
  extractMagnifierSlice,
} from '../utils/terminalMagnifierHelper';
import {
  attachMobileImeHandler,
  TerminalImeController,
} from '../utils/terminalImeHelper';

const DARK_TERMINAL_THEME = {
  background: '#090A0F',
  foreground: '#F1F5F9',
  cursor: '#818CF8',
  cursorAccent: '#090A0F',
  selectionBackground: 'rgba(99, 102, 241, 0.4)',
  black: '#090A0F',
  red: '#F43F5E',
  green: '#10B981',
  yellow: '#F59E0B',
  blue: '#6366F1',
  magenta: '#D946EF',
  cyan: '#06B6D4',
  white: '#F8FAFC',
  brightBlack: '#475569',
  brightRed: '#FB7185',
  brightGreen: '#34D399',
  brightYellow: '#FBBF24',
  brightBlue: '#818CF8',
  brightMagenta: '#E879F9',
  brightCyan: '#22D3EE',
  brightWhite: '#FFFFFF',
};

const LIGHT_TERMINAL_THEME = {
  background: '#FFFFFF',
  foreground: '#0F172A',
  cursor: '#4F46E5',
  cursorAccent: '#FFFFFF',
  selectionBackground: 'rgba(79, 70, 229, 0.25)',
  black: '#0F172A',
  red: '#E11D48',
  green: '#059669',
  yellow: '#D97706',
  blue: '#2563EB',
  magenta: '#9333EA',
  cyan: '#0891B2',
  white: '#F1F5F9',
  brightBlack: '#64748B',
  brightRed: '#F43F5E',
  brightGreen: '#10B981',
  brightYellow: '#F59E0B',
  brightBlue: '#4F46E5',
  brightMagenta: '#A855F7',
  brightCyan: '#06B6D4',
  brightWhite: '#0F172A',
};

export interface WebTerminalHandle {
  zoomIn: () => void;
  zoomOut: () => void;
  reconnect: () => void;
  resetSession: () => void;
  toggleSelectMode: () => void;
  fit: (force?: boolean) => void;
  scrollToBottomSafe?: () => void;
  isAtBottom?: () => boolean;
  updateCursorShift?: () => void;
  isSelectMode: boolean;
}

export interface WebTerminalViewProps {
  adminKey: string;
  standalone?: boolean;
  onExitStandalone?: () => void;
  onToggleStandalone?: (val: boolean) => void;
  subTab?: 'interactive' | 'logs';
  onSubTabChange?: (tab: 'interactive' | 'logs') => void;
  controlledHostId?: string;
  onControlledHostChange?: (newHostId: string) => void;
  hideInnerHostSelector?: boolean;
  hideHeader?: boolean;
  hideAccessoryBar?: boolean;
  onConnectionChange?: (status: { isConnected: boolean; isConnecting: boolean }) => void;
  onSelectModeChange?: (isSelect: boolean) => void;
  onRequestAddNode?: () => void;
}

const WebTerminalView = React.forwardRef<WebTerminalHandle, WebTerminalViewProps>(function WebTerminalView({
  adminKey,
  standalone = false,
  onExitStandalone,
  onToggleStandalone,
  subTab,
  onSubTabChange,
  controlledHostId,
  onControlledHostChange,
  hideInnerHostSelector = false,
  hideHeader = false,
  hideAccessoryBar = false,
  onConnectionChange,
  onSelectModeChange,
  onRequestAddNode,
}: WebTerminalViewProps, ref) {
  const { t } = useTranslation();
  const { resolvedTheme } = useTheme();
  const terminalContainerRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  const [isConnected, setIsConnected] = useState<boolean>(false);
  const [isConnecting, setIsConnecting] = useState<boolean>(true);
  const [reconnectCountdown, setReconnectCountdown] = useState<number>(0);
  const [isCtrlActive, setIsCtrlActive] = useState<boolean>(false);
  const [isAltActive, setIsAltActive] = useState<boolean>(false);
  const [isShiftActive, setIsShiftActive] = useState<boolean>(false);
  const [isKeyboardOpen, setIsKeyboardOpen] = useState<boolean>(false);
  const [hasSelection, setHasSelection] = useState<boolean>(false);
  const [selectedCharCount, setSelectedCharCount] = useState<number>(0);
  const [isSelectMode, setIsSelectMode] = useState<boolean>(false);
  const [magnifier, setMagnifier] = useState<{
    visible: boolean;
    x: number;
    y: number;
    textBefore: string;
    focusChar: string;
    textAfter: string;
    isFlippedBelow: boolean;
  }>({
    visible: false,
    x: 0,
    y: 0,
    textBefore: '',
    focusChar: ' ',
    textAfter: '',
    isFlippedBelow: false,
  });
  const [activeHostId, setActiveHostId] = useState<string>(() => {
    return controlledHostId !== undefined ? controlledHostId : (localStorage.getItem('terminal_active_host') || '');
  });
  const activeHostIdRef = useRef<string>(activeHostId);
  activeHostIdRef.current = activeHostId;

  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const toastTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const [isRefitting, setIsRefitting] = useState<boolean>(false);
  const isRefittingRef = useRef<boolean>(false);
  const refitTimerRef = useRef<NodeJS.Timeout | null>(null);
  const resizeDebounceTimerRef = useRef<NodeJS.Timeout | null>(null);

  const isSelectModeRef = useRef<boolean>(false);
  isSelectModeRef.current = isSelectMode;

  const showToast = useCallback((msg: string) => {
    if (toastTimeoutRef.current) {
      clearTimeout(toastTimeoutRef.current);
    }
    setToastMessage(msg);
    toastTimeoutRef.current = setTimeout(() => {
      setToastMessage(null);
    }, 2000);
  }, []);

  const isCtrlActiveRef = useRef<boolean>(isCtrlActive);
  isCtrlActiveRef.current = isCtrlActive;

  const isAltActiveRef = useRef<boolean>(isAltActive);
  isAltActiveRef.current = isAltActive;

  const isShiftActiveRef = useRef<boolean>(isShiftActive);
  isShiftActiveRef.current = isShiftActive;

  const reconnectAttemptRef = useRef<number>(0);
  const countdownIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const isMountedRef = useRef<boolean>(true);
  const isProcessExitedRef = useRef<boolean>(false);
  const isReplayingRef = useRef<boolean>(true);
  const replayTimerRef = useRef<NodeJS.Timeout | null>(null);
  const isInitialStandaloneMountRef = useRef<boolean>(true);
  const hasFirstDataFittedRef = useRef<boolean>(false);
  const [isAtBottom, setIsAtBottom] = useState<boolean>(true);
  const isAtBottomRef = useRef<boolean>(true);

  const lastSentColsRef = useRef<number>(0);
  const lastSentRowsRef = useRef<number>(0);
  const viewportDebounceTimerRef = useRef<NodeJS.Timeout | null>(null);
  const pingIntervalRef = useRef<NodeJS.Timeout | null>(null);

  const [isMobile, setIsMobile] = useState<boolean>(() => {
    return typeof window !== 'undefined'
      ? window.innerWidth < 768 || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
      : false;
  });
  const isMobileRef = useRef<boolean>(isMobile);
  useEffect(() => {
    isMobileRef.current = isMobile;
  }, [isMobile]);

  const standaloneRef = useRef<boolean>(standalone);
  useEffect(() => {
    standaloneRef.current = standalone;
  }, [standalone]);

  const clearPingInterval = useCallback(() => {
    if (pingIntervalRef.current) {
      clearInterval(pingIntervalRef.current);
      pingIntervalRef.current = null;
    }
  }, []);

  const [fontSize, setFontSize] = useState<number>(() => {
    const mobile = typeof window !== 'undefined'
      ? window.innerWidth < 768 || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
      : false;
    const storageKey = mobile ? 'terminal_font_size_mobile' : 'terminal_font_size';
    const saved = typeof localStorage !== 'undefined' ? localStorage.getItem(storageKey) : null;
    return saved ? parseInt(saved, 10) : (mobile ? 11 : 13);
  });

  // Mobile Visual Viewport tracking for virtual keyboard positioning
  const headerRef = useRef<HTMLDivElement>(null);
  const [viewportStyle, setViewportStyle] = useState<React.CSSProperties>({});

  const baseHeightRef = useRef<number>(typeof window !== 'undefined' ? window.innerHeight : 0);
  const baseWidthRef = useRef<number>(typeof window !== 'undefined' ? window.innerWidth : 0);
  const isKeyboardShowingRef = useRef<boolean>(false);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      baseHeightRef.current = Math.max(baseHeightRef.current, window.innerHeight);
      baseWidthRef.current = window.innerWidth;
    }
  }, [standalone]);

  const handleHideKeyboard = () => {
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

    // Always scroll xterm to bottom cursor line upon keyboard collapse
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
  };

  const fontSizeRef = useRef<number>(fontSize);
  fontSizeRef.current = fontSize;

  const [cursorShiftY, setCursorShiftY] = useState<number>(0);
  const cursorShiftYRef = useRef<number>(0);
  const updateCursorShiftRef = useRef<() => void>(() => {});

  const updateCursorShift = useCallback(() => {
    if (!isMountedRef.current || !xtermRef.current || !terminalContainerRef.current) return;
    const term = xtermRef.current;
    const container = terminalContainerRef.current;

    const isMobileDevice = isMobile || (typeof window !== 'undefined' && (window.innerWidth < 768 || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)));
    const isKeyboardActive = isKeyboardShowingRef.current || isKeyboardOpen || (
      isMobileDevice && typeof window !== 'undefined' && window.visualViewport && (
        window.visualViewport.height < (baseHeightRef.current || window.innerHeight) * 0.85
      )
    );

    if (!isMobileDevice || !isKeyboardActive) {
      if (cursorShiftYRef.current !== 0) {
        cursorShiftYRef.current = 0;
        setCursorShiftY(0);
      }
      return;
    }

    const actualCellHeight = (term as any)._core?._renderService?.dimensions?.actualCellHeight;
    const screenEl = (term as any).element?.querySelector('.xterm-screen') as HTMLElement | null;
    const cellHeight = (typeof actualCellHeight === 'number' && actualCellHeight > 0)
      ? actualCellHeight
      : (screenEl && term.rows > 0 ? screenEl.clientHeight / term.rows : 0)
      || Math.max(12, fontSizeRef.current * 1.3);

    const totalScreenHeight = screenEl?.clientHeight || (term.rows * cellHeight);

    // Visible viewport height above the keyboard and accessory bar
    let visibleHeight = container.parentElement?.clientHeight || container.clientHeight;
    if (typeof window !== 'undefined' && window.visualViewport) {
      // Header height ~44, Accessory bar ~44, container padding ~16
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

    // Cursor position within the active screen buffer (0-indexed)
    const cursorY = term.buffer?.active?.cursorY ?? (term.rows - 1);
    const cursorBottom = (cursorY + 1) * cellHeight;

    if (cursorBottom <= visibleHeight) {
      if (cursorShiftYRef.current !== 0) {
        cursorShiftYRef.current = 0;
        setCursorShiftY(0);
      }
      return;
    }

    const maxShift = Math.max(0, totalScreenHeight - visibleHeight);
    // Align cursor line with bottom of visible container, leaving 4px breathing room
    const targetShift = Math.max(0, cursorBottom - visibleHeight + 4);
    const shift = Math.min(maxShift, targetShift);
    const roundedShift = Math.round(shift);

    if (cursorShiftYRef.current !== roundedShift) {
      cursorShiftYRef.current = roundedShift;
      setCursorShiftY(roundedShift);
    }
  }, [isMobile, isKeyboardOpen]);

  useEffect(() => {
    updateCursorShiftRef.current = updateCursorShift;
  }, [updateCursorShift]);


  const sendResize = useCallback((cols: number, rows: number, force: boolean = false) => {
    if (cols <= 0 || rows <= 0) return;
    if (!force && cols === lastSentColsRef.current && rows === lastSentRowsRef.current) {
      return;
    }

    const isMobileDevice = isMobileRef.current || (typeof window !== 'undefined' && (window.innerWidth < 768 || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)));
    if (isMobileDevice && !force && lastSentRowsRef.current > 0) {
      const isWidthUnchanged = Math.abs(cols - lastSentColsRef.current) <= 2;
      const isHeightShrunk = rows < lastSentRowsRef.current;
      const isKeyboardActive = isKeyboardShowingRef.current || (
        typeof window !== 'undefined' && window.visualViewport && window.visualViewport.height < (baseHeightRef.current || window.innerHeight) * 0.85
      );
      if (isWidthUnchanged && (isHeightShrunk || isKeyboardActive)) {
        console.debug(`[WebTerminal] Blocked mobile keyboard resize leak: ${cols}x${rows} (cached: ${lastSentColsRef.current}x${lastSentRowsRef.current})`);
        return;
      }
    }

    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      lastSentColsRef.current = cols;
      lastSentRowsRef.current = rows;
      console.debug(`[WebTerminal] Sending resize to backend: ${cols}x${rows}`);
      wsRef.current.send(`JSON:${JSON.stringify({ type: 'resize', cols, rows })}`);
    }
  }, []);

  const safeFit = useCallback((forceResize: boolean = false): boolean => {
    if (!isMountedRef.current || !fitAddonRef.current || !xtermRef.current || !terminalContainerRef.current) {
      return false;
    }
    const container = terminalContainerRef.current;
    if (container.clientWidth <= 0 || container.clientHeight <= 0) {
      return false;
    }

    const isMobileDevice = isMobile || (typeof window !== 'undefined' && (window.innerWidth < 768 || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)));

    if (!forceResize && isMobile && standalone && isKeyboardShowingRef.current) {
      return false;
    }

    const isKeyboardActive = isKeyboardShowingRef.current || (
      isMobileDevice && typeof window !== 'undefined' && window.visualViewport && (
        window.visualViewport.height < (baseHeightRef.current || window.innerHeight) * 0.85
      )
    );

    if (!forceResize && isMobileDevice && isKeyboardActive) {
      return false;
    }

    if (!forceResize && isMobileDevice && lastSentRowsRef.current > 0) {
      const isWidthUnchanged = Math.abs(container.clientWidth - baseWidthRef.current) <= 25;
      const isHeightShrunk = typeof window !== 'undefined' && window.visualViewport && (
        window.visualViewport.height < (baseHeightRef.current || window.innerHeight) * 0.85
      );
      if (isWidthUnchanged && (isHeightShrunk || isKeyboardActive)) {
        return false;
      }
    }

    try {
      const term = xtermRef.current;
      const wasAtBottom = isUserAtBottom(term);
      const proposed = fitAddonRef.current.proposeDimensions();
      if (!proposed || proposed.cols <= 2 || proposed.rows <= 1) {
        return false;
      }
      fitAddonRef.current.fit();
      const { cols, rows } = term;
      if (cols > 2 && rows > 1) {
        sendResize(cols, rows, forceResize);
        if (shouldScrollToBottom({ isReplaying: isReplayingRef.current, wasAtBottom, bufferType: term.buffer.active.type })) {
          scrollToBottomSafe(term);
        }
        term.refresh(0, Math.max(0, rows - 1));
        return true;
      }
    } catch (err) {
      console.debug('[WebTerminal] safeFit bypassed:', err);
    }
    return false;
  }, [sendResize]);

  const safeFitRef = useRef(safeFit);
  safeFitRef.current = safeFit;

  const clearReconnectTimers = useCallback(() => {
    if (countdownIntervalRef.current) {
      clearInterval(countdownIntervalRef.current);
      countdownIntervalRef.current = null;
    }
    clearPingInterval();
    setReconnectCountdown(0);
  }, [clearPingInterval]);

  const initWebSocket = useCallback(() => {
    clearReconnectTimers();
    isProcessExitedRef.current = false;
    isReplayingRef.current = true;
    hasFirstDataFittedRef.current = false;
    lastSentColsRef.current = 0;
    lastSentRowsRef.current = 0;

    if (wsRef.current) {
      const oldWs = wsRef.current;
      oldWs.onopen = null;
      oldWs.onmessage = null;
      oldWs.onerror = null;
      oldWs.onclose = null;
      try {
        oldWs.close();
      } catch {}
      wsRef.current = null;
    }

    if (!activeHostIdRef.current) {
      setIsConnecting(false);
      setIsConnected(false);
      return;
    }

    setIsConnecting(true);
    setIsConnected(false);

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    const wsUrl = `${protocol}//${host}/api/terminal/ws?x-admin-key=${encodeURIComponent(adminKey)}&hostId=${encodeURIComponent(activeHostIdRef.current)}`;

    const ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';
    wsRef.current = ws;

    ws.onopen = () => {
      console.debug('[WebTerminal] WebSocket connection established successfully');
      setIsConnecting(false);
      setIsConnected(true);
      reconnectAttemptRef.current = 0;
      clearReconnectTimers();
      clearPingInterval();

      // Start ping heartbeat (every 15 seconds) to prevent reverse proxy/NAT idle drop
      pingIntervalRef.current = setInterval(() => {
        if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
          try {
            wsRef.current.send(`JSON:${JSON.stringify({ type: 'ping' })}`);
          } catch {}
        }
      }, 15000);

      // Reset xterm buffer so replayed history stream does not duplicate existing content
      if (xtermRef.current) {
        xtermRef.current.clear();
        xtermRef.current.reset();
      }

      isReplayingRef.current = true;
      if (replayTimerRef.current) {
        clearTimeout(replayTimerRef.current);
      }
      replayTimerRef.current = setTimeout(() => {
        isReplayingRef.current = false;
        scrollToBottomSafe(xtermRef.current);
      }, 600);

      lastSentColsRef.current = 0;
      lastSentRowsRef.current = 0;
      if (!safeFit(true)) {
        setTimeout(() => safeFit(true), 80);
      }
      setTimeout(() => safeFit(true), 250);
      setTimeout(() => safeFit(true), 600);
    };

    ws.onmessage = (event) => {
      const term = xtermRef.current;
      if (!hasFirstDataFittedRef.current || (term && (term.cols <= 2 || term.rows <= 1))) {
        hasFirstDataFittedRef.current = true;
        safeFit(true);
      }
      const data = event.data;
      if (typeof data === 'string') {
        if (data.startsWith('JSON:')) {
          try {
            const parsed = JSON.parse(data.slice(5));
            if (parsed.type === 'pong') {
              // Server keepalive heartbeat response
              return;
            }
            console.debug('[WebTerminal] Received backend control message:', parsed);
            if (parsed.type === 'reset') {
              console.debug('[WebTerminal] Received reset signal from backend, clearing buffer and muting synthetic reports');
              xtermRef.current?.clear();
              xtermRef.current?.reset();
              isReplayingRef.current = true;
              if (replayTimerRef.current) {
                clearTimeout(replayTimerRef.current);
              }
              replayTimerRef.current = setTimeout(() => {
                isReplayingRef.current = false;
                scrollToBottomSafe(xtermRef.current);
              }, 600);
              if (fitAddonRef.current && xtermRef.current) {
                fitAddonRef.current.fit();
                sendResize(xtermRef.current.cols, xtermRef.current.rows);
                scrollToBottomSafe(xtermRef.current);
              }
              return;
            }
            if (parsed.type === 'status' && parsed.event === 'exit') {
              xtermRef.current?.writeln('\r\n\x1b[33m[Process Completed]\x1b[0m\r\n');
              isProcessExitedRef.current = true;
              setIsConnected(false);
              clearReconnectTimers();
            }
            return;
          } catch {
            // Not json, print as raw text
          }
        }
        const term = xtermRef.current;
        const wasAtBottom = isAtBottomRef.current;
        term?.write(data, () => {
          if (!isRefittingRef.current && shouldScrollToBottom({ isReplaying: isReplayingRef.current, wasAtBottom, bufferType: term?.buffer.active.type })) {
            scrollToBottomSafe(term);
          }
          if (isReplayingRef.current) {
            term?.refresh(0, Math.max(0, (term.rows || 1) - 1));
            isReplayingRef.current = false;
          }
        });
      } else if (data instanceof ArrayBuffer) {
        const term = xtermRef.current;
        const wasAtBottom = isAtBottomRef.current;
        term?.write(new Uint8Array(data), () => {
          if (!isRefittingRef.current && shouldScrollToBottom({ isReplaying: isReplayingRef.current, wasAtBottom, bufferType: term?.buffer.active.type })) {
            scrollToBottomSafe(term);
          }
          if (isReplayingRef.current) {
            term?.refresh(0, Math.max(0, (term.rows || 1) - 1));
            isReplayingRef.current = false;
          }
        });
      }
    };

    const triggerReconnect = () => {
      setIsConnecting(false);
      setIsConnected(false);

      if (!isMountedRef.current || isProcessExitedRef.current) {
        return;
      }

      clearReconnectTimers();
      const delayMs = Math.min(15000, 1000 * Math.pow(2, reconnectAttemptRef.current));
      let remaining = Math.ceil(delayMs / 1000);
      setReconnectCountdown(remaining);
      reconnectAttemptRef.current += 1;

      countdownIntervalRef.current = setInterval(() => {
        remaining -= 1;
        setReconnectCountdown(remaining);
        if (remaining <= 0) {
          clearReconnectTimers();
          initWebSocket();
        }
      }, 1000);
    };

    ws.onclose = () => {
      clearPingInterval();
      triggerReconnect();
    };

    ws.onerror = (err) => {
      clearPingInterval();
      console.debug('[WebTerminal] WebSocket encountered error:', err);
    };
  }, [adminKey, clearReconnectTimers, sendResize, clearPingInterval]);

  // Lock body scroll and set overscroll-behavior when standalone is active
  useEffect(() => {
    if (standalone) {
      const originalOverflow = document.body.style.overflow;
      const originalOverscroll = document.body.style.overscrollBehavior;
      const originalTouchAction = document.body.style.touchAction;
      const originalPosition = document.body.style.position;
      const originalWidth = document.body.style.width;
      const originalHeight = document.body.style.height;

      document.body.style.overflow = 'hidden';
      document.body.style.overscrollBehavior = 'none';
      document.body.style.touchAction = 'pan-y';
      document.body.style.position = 'fixed';
      document.body.style.width = '100%';
      document.body.style.height = '100%';
      document.documentElement.style.overflow = 'hidden';
      document.documentElement.style.overscrollBehavior = 'none';

      return () => {
        document.body.style.overflow = originalOverflow;
        document.body.style.overscrollBehavior = originalOverscroll;
        document.body.style.touchAction = originalTouchAction;
        document.body.style.position = originalPosition;
        document.body.style.width = originalWidth;
        document.body.style.height = originalHeight;
        document.documentElement.style.overflow = '';
        document.documentElement.style.overscrollBehavior = '';
      };
    }
  }, [standalone]);

  // Initialize xterm instance
  useEffect(() => {
    if (!terminalContainerRef.current) return;

    const term = new Terminal({
      cursorBlink: true,
      cursorStyle: 'block',
      fontSize,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
      convertEol: false,
      scrollback: 5000,
      macOptionIsMeta: true,
      altClickMovesCursor: true,
      theme: resolvedTheme === 'dark' ? DARK_TERMINAL_THEME : LIGHT_TERMINAL_THEME,
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();

    term.loadAddon(fitAddon);
    term.loadAddon(webLinksAddon);
    term.open(terminalContainerRef.current);

    // Code-server mobile textarea optimization
    const helperTextarea = terminalContainerRef.current.querySelector('textarea');
    let handleFocus: (() => void) | null = null;
    let handleBlur: (() => void) | null = null;
    let imeController: TerminalImeController | null = null;
    if (helperTextarea) {
      helperTextarea.setAttribute('autocapitalize', 'none');
      helperTextarea.setAttribute('autocomplete', 'off');
      helperTextarea.setAttribute('autocorrect', 'off');
      helperTextarea.setAttribute('spellcheck', 'false');
      helperTextarea.setAttribute('tabindex', '0');
      helperTextarea.setAttribute('aria-label', 'Terminal input');
      helperTextarea.setAttribute('enterkeyhint', 'done');

      handleFocus = () => {
        setIsKeyboardOpen(true);
        setTimeout(() => updateViewport(), 50);
      };
      handleBlur = () => {
        setIsKeyboardOpen(false);
        isKeyboardShowingRef.current = false;
        cursorShiftYRef.current = 0;
        setCursorShiftY(0);
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
      };
      helperTextarea.addEventListener('focus', handleFocus);
      helperTextarea.addEventListener('blur', handleBlur);

      imeController = attachMobileImeHandler({
        textarea: helperTextarea,
        onDirectInput: (data) => {
          if (!isMountedRef.current || !xtermRef.current) return;
          term.input(data, true);
        },
      });
    }

    xtermRef.current = term;
    fitAddonRef.current = fitAddon;

    const cursorMoveDisposable = term.onCursorMove(() => {
      updateCursorShiftRef.current?.();
    });
    const renderDisposable = term.onRender(() => {
      updateCursorShiftRef.current?.();
    });
    const scrollDisposable = term.onScroll(() => {
      if (!term || !isMountedRef.current) return;
      if (term.buffer.active.type === 'alternate') {
        if (!isAtBottomRef.current) {
          isAtBottomRef.current = true;
          setIsAtBottom(true);
        }
        return;
      }
      const atBottom = isUserAtBottom(term);
      if (isAtBottomRef.current !== atBottom) {
        isAtBottomRef.current = atBottom;
        setIsAtBottom(atBottom);
      }
    });

    // Virtual modifier keyboard event handler (CTRL/ALT key combination interception & auto-release)
    term.attachCustomKeyEventHandler((domEvent: KeyboardEvent) => {
      if (domEvent.type !== 'keydown') {
        return true;
      }

      const isCtrl = isCtrlActiveRef.current;
      const isAlt = isAltActiveRef.current;
      const isShift = isShiftActiveRef.current;

      if (!isCtrl && !isAlt && !isShift) {
        return true;
      }

      const encoded = encodeModifierKey(domEvent, isCtrl, isAlt, isShift);
      if (encoded !== null) {
        if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
          wsRef.current.send(encoded);
        }
        term.focus();
        scrollToBottomSafe(term);

        setIsCtrlActive(false);
        setIsAltActive(false);
        setIsShiftActive(false);
        isCtrlActiveRef.current = false;
        isAltActiveRef.current = false;
        isShiftActiveRef.current = false;

        domEvent.preventDefault();
        domEvent.stopPropagation();
        return false;
      }

      return true;
    });

    // Track selection changes on xterm instance
    const selectionDisposable = term.onSelectionChange(() => {
      const selected = term.hasSelection();
      setHasSelection(selected);
      if (selected) {
        const text = term.getSelection();
        setSelectedCharCount(text.length);
      } else {
        setSelectedCharCount(0);
      }
    });

    // Observe container resize with RAF debouncing and mobile keyboard suppression
    let resizeRaf: number | null = null;
    let lastContainerWidth = 0;
    let lastContainerHeight = 0;

    const resizeObserver = new ResizeObserver(() => {
      if (resizeRaf !== null) {
        cancelAnimationFrame(resizeRaf);
      }
      resizeRaf = requestAnimationFrame(() => {
        resizeRaf = null;
        if (!isMountedRef.current || !terminalContainerRef.current) return;
        const width = terminalContainerRef.current.clientWidth;
        const height = terminalContainerRef.current.clientHeight;
        if (width <= 0 || height <= 0) return;

        // Skip if dimensions have not changed
        if (width === lastContainerWidth && height === lastContainerHeight) {
          return;
        }
        lastContainerWidth = width;
        lastContainerHeight = height;

        // Suppress fitting when mobile keyboard is open to avoid shrinking terminal rows
        if (isKeyboardShowingRef.current) {
          updateCursorShiftRef.current?.();
          return;
        }

        // Direct mobile virtual keyboard check to eliminate any race condition with updateViewport
        const isMobileDevice = isMobile || (typeof window !== 'undefined' && (window.innerWidth < 768 || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)));
        if (isMobileDevice) {
          const isWidthStable = Math.abs(width - baseWidthRef.current) <= 25;
          const isKeyboardActive = (
            (typeof window !== 'undefined' && window.visualViewport && window.visualViewport.height < (baseHeightRef.current || window.innerHeight) * 0.85) ||
            isKeyboardShowingRef.current
          );
          if (isWidthStable && (isKeyboardActive || isKeyboardShowingRef.current)) {
            updateCursorShiftRef.current?.();
            return;
          }
        }

        safeFitRef.current?.(false);
      });
    });

    if (terminalContainerRef.current) {
      resizeObserver.observe(terminalContainerRef.current);
    }

    // Mobile Touch Gesture & Vim Navigation Bridge (code-server / VS Code style)
    let touchStartY = 0;
    let touchStartX = 0;
    let touchStartTime = 0;
    let isDragging = false;
    let accumulatedDeltaY = 0;
    let selectionStartPos: { col: number; viewportRow: number; bufferRow: number } | null = null;
    const container = terminalContainerRef.current;

    // Desktop Copy on Select: automatically copy selected text on mouseup
    const handleMouseUp = () => {
      const mobile = window.innerWidth < 768 || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
      if (mobile) return;

      setTimeout(() => {
        if (!xtermRef.current) return;
        const term = xtermRef.current;
        if (term.hasSelection()) {
          const selectedText = term.getSelection();
          if (selectedText && selectedText.trim().length > 0) {
            if (navigator.clipboard && navigator.clipboard.writeText) {
              navigator.clipboard.writeText(selectedText).then(() => {
                showToast(t('webTerminal.copiedToClipboard'));
              }).catch(() => {
                // Fallback
                try {
                  const textarea = document.createElement('textarea');
                  textarea.value = selectedText;
                  textarea.style.position = 'fixed';
                  textarea.style.opacity = '0';
                  document.body.appendChild(textarea);
                  textarea.focus();
                  textarea.select();
                  document.execCommand('copy');
                  document.body.removeChild(textarea);
                  showToast(t('webTerminal.copiedToClipboard'));
                } catch {}
              });
            }
          }
        }
      }, 30);
    };

    const containerEl = terminalContainerRef.current;
    if (containerEl) {
      containerEl.addEventListener('mouseup', handleMouseUp);
    }

    // Helper: convert screen touch coordinates to terminal cell coordinates (0-based)
    const getCellCoordsFromTouch = (clientX: number, clientY: number) => {
      const screenEl = (container?.querySelector('.xterm-screen') as HTMLElement) || container;
      if (!screenEl) return null;
      const rect = screenEl.getBoundingClientRect();
      const relativeX = clientX - rect.left;
      const relativeY = clientY - rect.top;

      // Extract rendered cell dimensions from xterm internal or fallback to font metrics
      const renderService = (term as any)._core?._renderService;
      const cellWidth = renderService?.dimensions?.css?.cell?.width || (rect.width / term.cols);
      const cellHeight = renderService?.dimensions?.css?.cell?.height || (rect.height / term.rows);

      const col = Math.max(0, Math.min(term.cols - 1, Math.floor(relativeX / cellWidth)));
      const viewportRow = Math.max(0, Math.min(term.rows - 1, Math.floor(relativeY / cellHeight)));
      const bufferRow = term.buffer.active.viewportY + viewportRow;

      return { col, viewportRow, bufferRow };
    };

    // Helper: apply terminal selection range supporting multi-line and reverse drag with strict document order
    const applySelection = (
      start: { col: number; bufferRow: number },
      current: { col: number; bufferRow: number }
    ) => {
      const selectionService = (term as any)._core?._selectionService;
      const startOrder = start.bufferRow * term.cols + start.col;
      const currentOrder = current.bufferRow * term.cols + current.col;
      const isReversed = startOrder > currentOrder;

      const from = isReversed ? current : start;
      const to = isReversed ? start : current;

      if (selectionService && selectionService._model) {
        selectionService._model.selectionStart = [from.col, from.bufferRow];
        selectionService._model.selectionEnd = [to.col + 1, to.bufferRow];
        selectionService._model.selectionStartLength = 0;
        selectionService.refresh();
        selectionService._fireEventIfSelectionChanged();
        return;
      }

      // Public API fallback using viewport-relative coordinates
      const viewportY = term.buffer.active.viewportY;
      const fromViewportRow = Math.max(0, Math.min(term.rows - 1, from.bufferRow - viewportY));
      const toViewportRow = Math.max(0, Math.min(term.rows - 1, to.bufferRow - viewportY));
      const length = Math.max(1, (to.bufferRow - from.bufferRow) * term.cols + (to.col - from.col) + 1);
      term.select(from.col, fromViewportRow, length);
    };

    const handleTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 1) {
        touchStartY = e.touches[0].clientY;
        touchStartX = e.touches[0].clientX;
        touchStartTime = Date.now();
        isDragging = false;
        accumulatedDeltaY = 0;

        if (isSelectModeRef.current) {
          if (e.cancelable) {
            e.preventDefault();
          }
          e.stopPropagation();
          // In Selection Mode: record initial selection touch origin and highlight initial cell
          const cell = getCellCoordsFromTouch(touchStartX, touchStartY);
          if (cell) {
            selectionStartPos = cell;
            applySelection(cell, cell);
          }
        }
      }
    };

    const handleTouchMove = (e: TouchEvent) => {
      if (e.touches.length !== 1) return;

      const currentY = e.touches[0].clientY;
      const currentX = e.touches[0].clientX;

      // IF IN SELECTION MODE: update selection range dynamically as finger drags immediately
      if (isSelectModeRef.current) {
        if (e.cancelable) {
          e.preventDefault();
        }
        e.stopPropagation();

        if (!selectionStartPos) {
          selectionStartPos = getCellCoordsFromTouch(touchStartX, touchStartY);
        }
        const currentCell = getCellCoordsFromTouch(currentX, currentY);
        if (selectionStartPos && currentCell) {
          applySelection(selectionStartPos, currentCell);
        }
        return;
      }

      const deltaY = touchStartY - currentY;
      const deltaX = touchStartX - currentX;

      // When virtual keyboard is showing on mobile, swipe down to dismiss
      if (isKeyboardShowingRef.current && deltaY < -25) {
        handleHideKeyboard();
      }

      if (!isDragging && (Math.abs(deltaY) > 8 || Math.abs(deltaX) > 8)) {
        isDragging = true;
      }

      if (!isDragging) return;

      if (e.cancelable) {
        e.preventDefault();
      }
      e.stopPropagation();

      // STANDARD MODE: terminal scrolling
      touchStartY = currentY;
      touchStartX = currentX;
      accumulatedDeltaY += deltaY;

      // Approximate line height based on current font size (e.g. ~18px per line)
      const currentFontSize = fontSizeRef.current;
      const lineHeight = Math.max(12, currentFontSize * 1.3);

      if (Math.abs(accumulatedDeltaY) >= lineHeight) {
        const linesToScroll = Math.trunc(accumulatedDeltaY / lineHeight);
        accumulatedDeltaY -= linesToScroll * lineHeight;

        // Standard terminal scrollback buffer scrolling (pure touch-based viewport scrolling)
        term.scrollLines(linesToScroll);
      }
    };

    const handleTouchEnd = (e: TouchEvent) => {
      const elapsed = Date.now() - touchStartTime;

      if (isSelectModeRef.current) {
        if (e.cancelable) {
          e.preventDefault();
        }
        e.stopPropagation();
        selectionStartPos = null;
        return;
      }

      if (!isDragging && elapsed < 350) {
        // Pure single tap -> Focus terminal & wake on-screen virtual keyboard synchronously
        if (isMobile && standalone) {
          isKeyboardShowingRef.current = true;
        }
        term.focus();
        const textarea = container?.querySelector('textarea');
        if (textarea) {
          textarea.focus({ preventScroll: true });
        }
      }
    };

    if (container) {
      container.addEventListener('touchstart', handleTouchStart, { passive: false, capture: true });
      container.addEventListener('touchmove', handleTouchMove, { passive: false, capture: true });
      container.addEventListener('touchend', handleTouchEnd, { passive: false, capture: true });
    }

    term.onData((data) => {
      // 1. Suppress all synthetic reports during session replay or connect/reset window
      if (isReplayingRef.current && isSyntheticTerminalReport(data)) {
        console.debug('[WebTerminal] Suppressed synthetic replay report:', JSON.stringify(data));
        return;
      }

      // 2. Suppress unsolicited machine-generated color/device reports when at normal shell prompt
      if (term.buffer.active.type !== 'alternate' && isUnsolicitedShellDeviceReport(data)) {
        console.debug('[WebTerminal] Suppressed unsolicited shell device report:', JSON.stringify(data));
        return;
      }

      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(data);
      }
      isAtBottomRef.current = true;
      setIsAtBottom(true);
      scrollToBottomSafe(term);
    });

    term.onKey(() => {});

    let cancelRaf = false;
    const fallbackTimers: NodeJS.Timeout[] = [];

    const triggerMountProbe = () => {
      if (typeof window === 'undefined') return;
      window.requestAnimationFrame(() => {
        if (cancelRaf) return;
        if (!safeFit(true)) {
          window.requestAnimationFrame(() => {
            if (cancelRaf) return;
            fallbackTimers.push(setTimeout(() => safeFit(true), 60));
            fallbackTimers.push(setTimeout(() => safeFit(true), 150));
            fallbackTimers.push(setTimeout(() => safeFit(true), 300));
            fallbackTimers.push(setTimeout(() => safeFit(true), 350));
            fallbackTimers.push(setTimeout(() => safeFit(false), 800));
          });
        } else {
          fallbackTimers.push(setTimeout(() => safeFit(true), 60));
          fallbackTimers.push(setTimeout(() => safeFit(true), 150));
          fallbackTimers.push(setTimeout(() => safeFit(true), 300));
          fallbackTimers.push(setTimeout(() => safeFit(true), 350));
          fallbackTimers.push(setTimeout(() => safeFit(false), 800));
        }
      });
    };

    triggerMountProbe();

    if (typeof document !== 'undefined' && document.fonts?.ready) {
      document.fonts.ready.then(() => {
        if (isMountedRef.current) {
          safeFit(true);
        }
      }).catch(() => {});
    }

    initWebSocket();

    // Resize observer & Visual Viewport updater
    function updateViewport() {
      const mobile = window.innerWidth < 768 || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
      setIsMobile(mobile);

      // Keep window scroll at top to avoid browser auto-scroll misalignment on mobile
      if (typeof window !== 'undefined' && window.scrollY !== 0) {
        window.scrollTo(0, 0);
      }

      let isKeyboardShowing = false;
      let translateY = 0;

      const textarea = terminalContainerRef.current?.querySelector('textarea');
      const isInputFocused = document.activeElement === textarea;

      const screenHeight = typeof window !== 'undefined' && window.screen ? window.screen.height : 0;

      if (window.visualViewport) {
        const vv = window.visualViewport;
        const currentHeight = Math.max(window.innerHeight, vv?.height || window.innerHeight);

        // Only record baseHeightRef when height is near full physical viewport height.
        // Avoids pollution on Android Chrome when keyboard opens or focus leaves textarea.
        const isNearFullHeight = (
          (screenHeight > 0 ? currentHeight >= screenHeight * 0.72 : true) &&
          (baseHeightRef.current <= 0 || currentHeight >= baseHeightRef.current - 100)
        );

        if (!isInputFocused && isNearFullHeight) {
          baseHeightRef.current = Math.max(baseHeightRef.current, currentHeight);
          baseWidthRef.current = window.innerWidth;
        }

        const offsetResult = calculateKeyboardTranslateY({
          baseHeight: baseHeightRef.current,
          viewportHeight: vv.height,
          offsetTop: 0,
          isInputFocused: isInputFocused || isKeyboardShowingRef.current,
        });
        isKeyboardShowing = offsetResult.isKeyboardShowing;
        translateY = offsetResult.translateY;

        if (isKeyboardShowing) {
          setIsKeyboardOpen(true);
        } else {
          setIsKeyboardOpen(false);
        }
      } else {
        const currentHeight = window.innerHeight;
        const isNearFullHeight = (
          (screenHeight > 0 ? currentHeight >= screenHeight * 0.72 : true) &&
          (baseHeightRef.current <= 0 || currentHeight >= baseHeightRef.current - 100)
        );
        if (!isInputFocused && isNearFullHeight) {
          baseHeightRef.current = Math.max(baseHeightRef.current, currentHeight);
          baseWidthRef.current = window.innerWidth;
        }
      }

      const wasKeyboardShowing = isKeyboardShowingRef.current;
      isKeyboardShowingRef.current = isKeyboardShowing;

      const isWidthStable = Math.abs(window.innerWidth - baseWidthRef.current) <= 20;

      if (wasKeyboardShowing && !isKeyboardShowing) {
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

        // Always scroll to bottom when keyboard closes
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

        // When keyboard closes on mobile standalone with stable width, rows was never shrunk,
        // so skip safeFit(true) to avoid triggering SIGWINCH and history buffer reflow.
        if (!mobile || !standalone || !isWidthStable) {
          setTimeout(() => {
            if (isMountedRef.current) {
              safeFit(true);
            }
          }, 260);
        }
      }

      if (mobile && standalone) {
        if (isKeyboardShowing) {
          const headerHeight = !hideHeader ? (headerRef.current?.offsetHeight || 44) : 0;
          const availableHeight = Math.max(120, (window.visualViewport?.height || baseHeightRef.current) - headerHeight);
          setViewportStyle({
            height: `${availableHeight}px`,
            maxHeight: `${availableHeight}px`,
            flex: 'none',
            transition: 'none',
            overflow: 'hidden',
          });
        } else {
          setViewportStyle({});
        }
      } else {
        setViewportStyle({});
      }

      const blockResize = shouldBlockPtyResize({
        baseWidth: baseWidthRef.current,
        currentWidth: window.innerWidth,
        isKeyboardShowing,
        isMobile: mobile,
        standalone,
        isInputFocused: isInputFocused || isKeyboardShowingRef.current,
      });

      if (blockResize) {
        if (!wasKeyboardShowing && xtermRef.current) {
          // Always keep viewport anchored to bottom cursor when keyboard opens
          scrollToBottomSafe(xtermRef.current);
        }
        updateCursorShiftRef.current?.();
      } else {
        // On mobile, never resize terminal rows on viewport changes unless width changes (screen rotation)
        const isWidthChanged = Math.abs(window.innerWidth - baseWidthRef.current) > 20;
        if ((!mobile || isWidthChanged) && !wasKeyboardShowing && fitAddonRef.current && xtermRef.current) {
          const term = xtermRef.current;
          const wasAtBottom = isUserAtBottom(term);
          fitAddonRef.current.fit();
          sendResize(term.cols, term.rows);
          if (shouldScrollToBottom({ isReplaying: isReplayingRef.current, wasAtBottom, bufferType: term.buffer.active.type })) {
            scrollToBottomSafe(term);
          }
        }
      }
    }

    const handleViewportChange = () => {
      if (viewportDebounceTimerRef.current) {
        clearTimeout(viewportDebounceTimerRef.current);
      }
      viewportDebounceTimerRef.current = setTimeout(() => {
        updateViewport();
      }, 16);
    };

    let orientationTimer: NodeJS.Timeout | null = null;
    const handleOrientationChange = () => {
      handleHideKeyboard();
      baseWidthRef.current = window.innerWidth;
      baseHeightRef.current = window.innerHeight;
      if (orientationTimer) {
        clearTimeout(orientationTimer);
      }
      orientationTimer = setTimeout(() => {
        if (isMountedRef.current && fitAddonRef.current && xtermRef.current) {
          const term = xtermRef.current;
          const wasAtBottom = isUserAtBottom(term);
          fitAddonRef.current.fit();
          sendResize(term.cols, term.rows);
          if (shouldScrollToBottom({ isReplaying: isReplayingRef.current, wasAtBottom, bufferType: term.buffer.active.type })) {
            scrollToBottomSafe(term);
          }
        }
      }, 100);
    };

    window.addEventListener('resize', handleViewportChange);
    window.addEventListener('orientationchange', handleOrientationChange);

    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', handleViewportChange);
      window.visualViewport.addEventListener('scroll', handleViewportChange);
    }

    updateViewport();

    return () => {
      cancelRaf = true;
      fallbackTimers.forEach((t) => clearTimeout(t));
      isMountedRef.current = false;
      clearReconnectTimers();
      if (orientationTimer) {
        clearTimeout(orientationTimer);
      }
      if (viewportDebounceTimerRef.current) {
        clearTimeout(viewportDebounceTimerRef.current);
      }
      if (replayTimerRef.current) {
        clearTimeout(replayTimerRef.current);
      }
      if (resizeRaf !== null) {
        cancelAnimationFrame(resizeRaf);
        resizeRaf = null;
      }
      resizeObserver.disconnect();
      if (helperTextarea) {
        if (handleFocus) helperTextarea.removeEventListener('focus', handleFocus);
        if (handleBlur) helperTextarea.removeEventListener('blur', handleBlur);
      }
      imeController?.dispose();
      if (container) {
        container.removeEventListener('touchstart', handleTouchStart, { capture: true } as any);
        container.removeEventListener('touchmove', handleTouchMove, { capture: true } as any);
        container.removeEventListener('touchend', handleTouchEnd, { capture: true } as any);
        container.removeEventListener('mouseup', handleMouseUp);
      }
      selectionDisposable.dispose();
      cursorMoveDisposable.dispose();
      renderDisposable.dispose();
      scrollDisposable.dispose();
      window.removeEventListener('resize', handleViewportChange);
      window.removeEventListener('orientationchange', handleOrientationChange);
      if (window.visualViewport) {
        window.visualViewport.removeEventListener('resize', handleViewportChange);
        window.visualViewport.removeEventListener('scroll', handleViewportChange);
      }
      clearPingInterval();
      if (wsRef.current) {
        const oldWs = wsRef.current;
        oldWs.onopen = null;
        oldWs.onmessage = null;
        oldWs.onerror = null;
        oldWs.onclose = null;
        try {
          oldWs.close();
        } catch {}
        wsRef.current = null;
      }
      term.dispose();
    };
  }, [sendResize, clearReconnectTimers, adminKey]);

  // Re-fit and send resize when standalone mode toggles without disconnecting WS
  useEffect(() => {
    if (isInitialStandaloneMountRef.current) {
      isInitialStandaloneMountRef.current = false;
      return;
    }

    setIsRefitting(true);
    isRefittingRef.current = true;
    if (refitTimerRef.current) clearTimeout(refitTimerRef.current);
    if (resizeDebounceTimerRef.current) clearTimeout(resizeDebounceTimerRef.current);

    resizeDebounceTimerRef.current = setTimeout(() => {
      if (fitAddonRef.current && xtermRef.current) {
        const term = xtermRef.current;
        fitAddonRef.current.fit();
        sendResize(term.cols, term.rows);
        term.refresh(0, Math.max(0, term.rows - 1));
      }
    }, 80);

    refitTimerRef.current = setTimeout(() => {
      isRefittingRef.current = false;
      setIsRefitting(false);
      if (xtermRef.current) {
        scrollToBottomSafe(xtermRef.current);
        xtermRef.current.refresh(0, Math.max(0, xtermRef.current.rows - 1));
      }
    }, 120);

    return () => {
      if (refitTimerRef.current) clearTimeout(refitTimerRef.current);
      if (resizeDebounceTimerRef.current) clearTimeout(resizeDebounceTimerRef.current);
    };
  }, [standalone, sendResize]);

  // Sync font size change
  useEffect(() => {
    if (xtermRef.current && fitAddonRef.current) {
      const term = xtermRef.current;
      const wasAtBottom = isUserAtBottom(term);
      term.options.fontSize = fontSize;
      const storageKey = isMobile ? 'terminal_font_size_mobile' : 'terminal_font_size';
      localStorage.setItem(storageKey, fontSize.toString());
      fitAddonRef.current.fit();
      sendResize(term.cols, term.rows);
      if (shouldScrollToBottom({ isReplaying: isReplayingRef.current, wasAtBottom, bufferType: term.buffer.active.type })) {
        scrollToBottomSafe(term);
      }
    }
  }, [fontSize, isMobile, sendResize]);

  // Dynamically update terminal palette when resolvedTheme changes
  useEffect(() => {
    if (xtermRef.current) {
      xtermRef.current.options.theme = resolvedTheme === 'dark' ? DARK_TERMINAL_THEME : LIGHT_TERMINAL_THEME;
    }
  }, [resolvedTheme]);

  // Sync touch-action & user-select styling during selection mode to prevent browser gesture cancellation
  useEffect(() => {
    const container = terminalContainerRef.current;
    if (!container) return;
    const xtermScreen = container.querySelector('.xterm-screen') as HTMLElement | null;
    const xtermEl = container.querySelector('.xterm') as HTMLElement | null;
    if (isSelectMode) {
      container.style.touchAction = 'none';
      if (xtermScreen) {
        xtermScreen.style.touchAction = 'none';
        xtermScreen.style.userSelect = 'none';
        xtermScreen.style.webkitUserSelect = 'none';
      }
      if (xtermEl) {
        xtermEl.style.touchAction = 'none';
        xtermEl.style.userSelect = 'none';
        xtermEl.style.webkitUserSelect = 'none';
      }
    } else {
      container.style.touchAction = '';
      if (xtermScreen) {
        xtermScreen.style.touchAction = '';
        xtermScreen.style.userSelect = '';
        xtermScreen.style.webkitUserSelect = '';
      }
      if (xtermEl) {
        xtermEl.style.touchAction = '';
        xtermEl.style.userSelect = '';
        xtermEl.style.webkitUserSelect = '';
      }
    }
  }, [isSelectMode]);

  const handleScrollToBottom = useCallback(() => {
    if (xtermRef.current) {
      isAtBottomRef.current = true;
      setIsAtBottom(true);
      scrollToBottomSafe(xtermRef.current);
      xtermRef.current.focus();
    }
  }, []);

  const handleSendInput = (data: string, shouldFocus = false) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(data);
    }
    if (shouldFocus) {
      xtermRef.current?.focus();
    }
    scrollToBottomSafe(xtermRef.current);
  };

  const handleToggleKeyboard = () => {
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
  };

  // Clipboard & Selection Action Handlers
  const handleCopySelection = useCallback(() => {
    const text = xtermRef.current?.getSelection();
    if (text) {
      const doCopy = () => {
        showToast(t('webTerminal.copiedToClipboard'));
        setIsSelectMode(false);
        isSelectModeRef.current = false;
        setMagnifier(prev => ({ ...prev, visible: false }));
        xtermRef.current?.clearSelection();
        setHasSelection(false);
        setSelectedCharCount(0);
      };

      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(doCopy).catch(() => {
          // Fallback if permission blocked or insecure context
          try {
            const textarea = document.createElement('textarea');
            textarea.value = text;
            textarea.style.position = 'fixed';
            textarea.style.opacity = '0';
            document.body.appendChild(textarea);
            textarea.focus();
            textarea.select();
            document.execCommand('copy');
            document.body.removeChild(textarea);
          } catch {
            // Ignore
          }
          doCopy();
        });
      } else {
        try {
          const textarea = document.createElement('textarea');
          textarea.value = text;
          textarea.style.position = 'fixed';
          textarea.style.opacity = '0';
          document.body.appendChild(textarea);
          textarea.focus();
          textarea.select();
          document.execCommand('copy');
          document.body.removeChild(textarea);
        } catch {
          // Ignore
        }
        doCopy();
      }
    }
  }, [showToast, t]);

  const handlePasteClipboard = useCallback(async () => {
    let clipText = '';

    // 1. Attempt modern asynchronous Clipboard API
    if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.readText) {
      try {
        clipText = await navigator.clipboard.readText();
      } catch (err) {
        console.warn('[WebTerminal] Clipboard readText failed, falling back to prompt:', err);
      }
    }

    // 2. Fallback: prompt for user input in insecure HTTP context or when permission denied
    if (!clipText && typeof window !== 'undefined') {
      const manualInput = window.prompt(t('webTerminal.pastePromptTip', '请长按粘贴文字：'));
      if (manualInput) {
        clipText = manualInput;
      }
    }

    // 3. If cancelled or still empty, safely return
    if (!clipText) {
      return;
    }

    // 4. Send directly to terminal via WebSocket pipeline & keep focus
    handleSendInput(clipText, false);
    if (xtermRef.current) {
      xtermRef.current.focus();
    }
  }, [handleSendInput, t]);

  const handleToggleSelectMode = useCallback(() => {
    setIsSelectMode((prev) => {
      const next = !prev;
      isSelectModeRef.current = next;
      if (next) {
        handleHideKeyboard();
        showToast(t('webTerminal.selectModeTip'));
      }
      return next;
    });
  }, [handleHideKeyboard, showToast, t]);

  const handleSelectAll = useCallback(() => {
    if (xtermRef.current) {
      const term = xtermRef.current;
      const viewportY = term.buffer.active.viewportY;
      const endRow = Math.min(term.buffer.active.length - 1, viewportY + term.rows - 1);
      const selectionService = (term as any)._core?._selectionService;
      if (selectionService && selectionService._model) {
        selectionService._model.selectionStart = [0, viewportY];
        selectionService._model.selectionEnd = [term.cols, endRow];
        selectionService._model.selectionStartLength = 0;
        selectionService.refresh();
        selectionService._fireEventIfSelectionChanged();
      } else {
        term.selectAll();
      }
      setHasSelection(true);
    }
  }, []);

  const handleClearSelection = useCallback(() => {
    if (xtermRef.current) {
      xtermRef.current.clearSelection();
      setHasSelection(false);
      setSelectedCharCount(0);
    }
  }, []);

  const handleExitSelectMode = useCallback(() => {
    setIsSelectMode(false);
    isSelectModeRef.current = false;
    setMagnifier(prev => ({ ...prev, visible: false }));
    handleClearSelection();
  }, [handleClearSelection]);

  // Selection Gesture Overlay Handlers
  const overlaySelectionStartRef = useRef<{ col: number; viewportRow: number; bufferRow: number } | null>(null);
  const isOverlayMouseSelectingRef = useRef<boolean>(false);
  const overlayMouseStartRef = useRef<{ col: number; bufferRow: number } | null>(null);

  const getOverlayCellCoords = useCallback((clientX: number, clientY: number) => {
    const container = terminalContainerRef.current;
    const term = xtermRef.current;
    if (!container || !term) return null;

    const screenEl = (container.querySelector('.xterm-screen') as HTMLElement) || container;
    if (!screenEl) return null;
    const rect = screenEl.getBoundingClientRect();
    const relativeX = clientX - rect.left;
    const relativeY = clientY - rect.top;

    const renderService = (term as any)._core?._renderService;
    const cellWidth = renderService?.dimensions?.css?.cell?.width || (rect.width / term.cols);
    const cellHeight = renderService?.dimensions?.css?.cell?.height || (rect.height / term.rows);

    const col = Math.max(0, Math.min(term.cols - 1, Math.floor(relativeX / cellWidth)));
    const viewportRow = Math.max(0, Math.min(term.rows - 1, Math.floor(relativeY / cellHeight)));
    const bufferRow = term.buffer.active.viewportY + viewportRow;

    return { col, viewportRow, bufferRow };
  }, []);

  const updateMagnifierFromTouch = useCallback((clientX: number, clientY: number) => {
    const term = xtermRef.current;
    if (!term) return;

    const screenWidth = typeof window !== 'undefined' ? window.innerWidth : 375;
    const pos = calculateMagnifierPosition(clientX, clientY, screenWidth);
    const cell = getOverlayCellCoords(clientX, clientY);

    let textBefore = '';
    let focusChar = ' ';
    let textAfter = '';

    if (cell) {
      const line = term.buffer.active.getLine(cell.bufferRow);
      if (line) {
        const lineText = line.translateToString(true);
        const slice = extractMagnifierSlice(lineText, cell.col, 6);
        textBefore = slice.textBefore;
        focusChar = slice.focusChar;
        textAfter = slice.textAfter;
      }
    }

    setMagnifier({
      visible: true,
      x: pos.x,
      y: pos.y,
      textBefore,
      focusChar,
      textAfter,
      isFlippedBelow: pos.isFlippedBelow,
    });
  }, [getOverlayCellCoords]);

  const applyOverlaySelection = useCallback((
    start: { col: number; bufferRow: number },
    current: { col: number; bufferRow: number }
  ) => {
    const term = xtermRef.current;
    if (!term) return;

    const selectionService = (term as any)._core?._selectionService;
    const startOrder = start.bufferRow * term.cols + start.col;
    const currentOrder = current.bufferRow * term.cols + current.col;
    const isReversed = startOrder > currentOrder;

    const from = isReversed ? current : start;
    const to = isReversed ? start : current;

    if (selectionService && selectionService._model) {
      selectionService._model.selectionStart = [from.col, from.bufferRow];
      selectionService._model.selectionEnd = [to.col + 1, to.bufferRow];
      selectionService._model.selectionStartLength = 0;
      selectionService.refresh();
      selectionService._fireEventIfSelectionChanged();
      return;
    }

    const viewportY = term.buffer.active.viewportY;
    const fromViewportRow = Math.max(0, Math.min(term.rows - 1, from.bufferRow - viewportY));
    const length = Math.max(1, (to.bufferRow - from.bufferRow) * term.cols + (to.col - from.col) + 1);
    term.select(from.col, fromViewportRow, length);
  }, []);

  const handleOverlayTouchStart = (e: React.TouchEvent<HTMLDivElement>) => {
    if (e.touches.length === 1) {
      const touch = e.touches[0];
      const cell = getOverlayCellCoords(touch.clientX, touch.clientY);
      if (cell) {
        overlaySelectionStartRef.current = cell;
        applyOverlaySelection(cell, cell);
        updateMagnifierFromTouch(touch.clientX, touch.clientY);
      }
    }
  };

  const handleOverlayTouchMove = (e: React.TouchEvent<HTMLDivElement>) => {
    if (e.touches.length === 1 && overlaySelectionStartRef.current) {
      const touch = e.touches[0];
      const currentCell = getOverlayCellCoords(touch.clientX, touch.clientY);
      if (currentCell) {
        applyOverlaySelection(overlaySelectionStartRef.current, currentCell);
        updateMagnifierFromTouch(touch.clientX, touch.clientY);
      }
    }
  };

  const handleOverlayTouchEnd = () => {
    overlaySelectionStartRef.current = null;
    setMagnifier(prev => ({ ...prev, visible: false }));
  };

  const handleOverlayMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    isOverlayMouseSelectingRef.current = true;
    const cell = getOverlayCellCoords(e.clientX, e.clientY);
    if (cell) {
      overlayMouseStartRef.current = cell;
      applyOverlaySelection(cell, cell);
    }
  };

  const handleOverlayMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!isOverlayMouseSelectingRef.current || !overlayMouseStartRef.current) return;
    const currentCell = getOverlayCellCoords(e.clientX, e.clientY);
    if (currentCell) {
      applyOverlaySelection(overlayMouseStartRef.current, currentCell);
    }
  };

  const handleOverlayMouseUp = () => {
    if (isOverlayMouseSelectingRef.current) {
      isOverlayMouseSelectingRef.current = false;
      overlayMouseStartRef.current = null;
      // Desktop Copy on Select: if text is selected, copy immediately and exit select mode
      const text = xtermRef.current?.getSelection();
      if (text && text.trim().length > 0) {
        handleCopySelection();
      }
    }
  };

  const handleManualReconnect = () => {
    reconnectAttemptRef.current = 0;
    initWebSocket();
  };

  const handleHostChange = (newHostId: string) => {
    lastSentColsRef.current = 0;
    lastSentRowsRef.current = 0;
    if (newHostId === activeHostIdRef.current && (wsRef.current?.readyState === WebSocket.OPEN || wsRef.current?.readyState === WebSocket.CONNECTING)) {
      return;
    }
    setActiveHostId(newHostId);
    activeHostIdRef.current = newHostId;
    localStorage.setItem('terminal_active_host', newHostId);
    if (onControlledHostChange) {
      onControlledHostChange(newHostId);
    }
    if (xtermRef.current) {
      xtermRef.current.clear();
      xtermRef.current.reset();
    }
    reconnectAttemptRef.current = 0;
    initWebSocket();
  };

  useEffect(() => {
    if (activeHostId) {
      const timers = [
        setTimeout(() => {
          safeFit(true);
        }, 60),
        setTimeout(() => { safeFit(true); }, 200),
        setTimeout(() => { safeFit(true); }, 500),
      ];
      return () => timers.forEach(clearTimeout);
    }
  }, [activeHostId, safeFit]);

  useEffect(() => {
    if (controlledHostId !== undefined && controlledHostId !== activeHostId) {
      lastSentColsRef.current = 0;
      lastSentRowsRef.current = 0;
      setActiveHostId(controlledHostId);
      activeHostIdRef.current = controlledHostId;
      if (xtermRef.current) {
        xtermRef.current.clear();
        xtermRef.current.reset();
      }
      reconnectAttemptRef.current = 0;
      initWebSocket();
    }
  }, [controlledHostId, activeHostId, initWebSocket]);

  const executeReset = useCallback(() => {
    lastSentColsRef.current = 0;
    lastSentRowsRef.current = 0;
    reconnectAttemptRef.current = 0;
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(`JSON:${JSON.stringify({ type: 'reset' })}`);
    }
    xtermRef.current?.clear();
    xtermRef.current?.reset();
  }, []);

  const handleResetSession = useCallback(() => {
    if (window.confirm(t('webTerminal.resetConfirm'))) {
      executeReset();
    }
  }, [t, executeReset]);

  useEffect(() => {
    onConnectionChange?.({ isConnected, isConnecting });
  }, [isConnected, isConnecting, onConnectionChange]);

  useEffect(() => {
    onSelectModeChange?.(isSelectMode);
  }, [isSelectMode, onSelectModeChange]);

  useImperativeHandle(ref, () => ({
    zoomIn: () => setFontSize((prev) => Math.min(22, prev + 1)),
    zoomOut: () => setFontSize((prev) => Math.max(9, prev - 1)),
    reconnect: handleManualReconnect,
    resetSession: executeReset,
    toggleSelectMode: handleToggleSelectMode,
    fit: (force: boolean = false) => safeFit(force),
    scrollToBottomSafe: () => {
      handleScrollToBottom();
    },
    isAtBottom: () => {
      return isAtBottomRef.current;
    },
    updateCursorShift: () => {
      updateCursorShift();
    },
    get isSelectMode() {
      return isSelectModeRef.current;
    },
  }), [handleManualReconnect, executeReset, handleToggleSelectMode, safeFit, sendResize, updateCursorShift, handleScrollToBottom]);

  const handleFullscreenToggle = () => {
    if (standalone) {
      onExitStandalone?.();
    } else {
      onToggleStandalone?.(true);
    }
  };

  return (
    <div
      className={`mx-auto flex flex-col bg-[var(--bg-canvas)] overflow-hidden font-mono text-xs transition-none ${
        hideHeader
          ? 'w-full h-full flex-1 border-none shadow-none rounded-none'
          : standalone
          ? 'fixed inset-0 z-50 rounded-none h-[100dvh] w-screen overflow-hidden overscroll-none border-none shadow-2xl'
          : 'w-full h-full md:max-w-7xl md:h-[calc(100vh-140px)] md:min-h-[500px] rounded-none md:rounded-2xl border border-[var(--border-subtle)] border-x-0 md:border-x border-t-0 md:border-t shadow-2xl'
      }`}
    >
      {/* Top Window Bar */}
      {!hideHeader && (
      <div ref={headerRef} className="bg-[var(--bg-surface-sub)] border-b border-[var(--border-subtle)] px-2 sm:px-4 py-1.5 sm:py-2 flex items-center justify-between select-none shrink-0 sticky top-0 z-30">
        <div className="flex items-center space-x-1.5 sm:space-x-2 min-w-0">
          {/* Back to Console (Standalone Mode) */}
          {standalone && onExitStandalone && (
            <button
              type="button"
              onClick={onExitStandalone}
              className="mr-1 px-1.5 sm:px-2 py-1 rounded-lg bg-white/[0.06] hover:bg-white/[0.12] text-slate-300 hover:text-white border border-white/[0.08] transition-all flex items-center space-x-1 text-xs active:scale-95"
              title={t('webTerminal.backToDashboard')}
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              <span className="hidden sm:inline font-sans text-[11px]">{t('webTerminal.backToDashboard')}</span>
            </button>
          )}

          {onSubTabChange ? (
            <div className="ui-tab-container p-0.5 text-[11px] font-medium shrink-0">
              <button
                type="button"
                onClick={() => onSubTabChange('interactive')}
                className={`flex items-center space-x-1.5 px-2 sm:px-2.5 py-1 rounded-lg transition-all ${
                  (subTab || 'interactive') === 'interactive'
                    ? 'ui-tab-pill-active font-semibold shadow-sm'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <TerminalSquare className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">{t('terminal.interactiveTab')}</span>
              </button>
              <button
                type="button"
                onClick={() => onSubTabChange('logs')}
                className={`flex items-center space-x-1.5 px-2 sm:px-2.5 py-1 rounded-lg transition-all ${
                  subTab === 'logs'
                    ? 'ui-tab-pill-active font-semibold shadow-sm'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <FileText className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">{t('terminal.logsTab')}</span>
              </button>
            </div>
          ) : null}

          {/* Host Selector */}
          {(!hideInnerHostSelector || standalone) && (
            <TerminalHostSelector
              adminKey={adminKey}
              activeHostId={activeHostId}
              onSelectHost={handleHostChange}
              connectionStatus={{ isConnected, isConnecting }}
            />
          )}

          {/* Connection Status Badge (desktop only) */}
          <div
            className={`hidden sm:flex items-center space-x-1 sm:space-x-1.5 px-1.5 sm:px-2 py-0.5 rounded-full text-[10px] font-medium border shrink-0 ${
              !activeHostId
                ? 'bg-slate-500/10 text-slate-400 border-slate-500/20'
                : isConnected
                ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                : isConnecting
                ? 'bg-amber-500/10 text-amber-400 border-amber-500/20'
                : 'bg-rose-500/10 text-rose-400 border-rose-500/20'
            }`}
          >
            <span
              className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                !activeHostId
                  ? 'bg-slate-500'
                  : isConnected
                  ? 'bg-emerald-400 animate-pulse'
                  : isConnecting
                  ? 'bg-amber-400 animate-ping'
                  : 'bg-rose-400'
              }`}
            />
            <span className="hidden sm:inline text-[10px]">
              {!activeHostId
                ? t('webTerminal.emptyState.noOnlineHosts', '无在线节点')
                : isConnected
                ? t('webTerminal.connected')
                : isConnecting
                ? t('webTerminal.connecting')
                : t('webTerminal.disconnected')}
            </span>
          </div>
        </div>

        {/* Action Buttons */}
        <div className="flex items-center space-x-0.5 sm:space-x-1.5 shrink-0">
          {/* Zoom Out */}
          <button
            type="button"
            onClick={() => setFontSize((prev) => Math.max(9, prev - 1))}
            className="hidden sm:inline-flex p-1 sm:p-1.5 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] text-slate-400 hover:text-white border border-white/[0.06] transition-all"
            title="Zoom Out"
          >
            <ZoomOut className="w-3.5 h-3.5" />
          </button>

          {/* Zoom In */}
          <button
            type="button"
            onClick={() => setFontSize((prev) => Math.min(22, prev + 1))}
            className="hidden sm:inline-flex p-1 sm:p-1.5 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] text-slate-400 hover:text-white border border-white/[0.06] transition-all"
            title="Zoom In"
          >
            <ZoomIn className="w-3.5 h-3.5" />
          </button>

          {/* Reconnect */}
          <button
            type="button"
            onClick={handleManualReconnect}
            className="p-1 sm:p-1.5 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] text-slate-400 hover:text-white border border-white/[0.06] transition-all"
            title={t('webTerminal.reconnect')}
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isConnecting ? 'animate-spin text-indigo-400' : ''}`} />
          </button>

          {/* Reset Terminal Session */}
          <button
            type="button"
            onClick={handleResetSession}
            className="p-1 sm:p-1.5 rounded-lg bg-white/[0.04] hover:bg-rose-500/20 text-slate-400 hover:text-rose-300 border border-white/[0.06] hover:border-rose-500/30 transition-all"
            title={t('webTerminal.resetSession')}
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>

          {/* Select / Copy Mode Toggle (Desktop & Mobile unified) */}
          <button
            type="button"
            onClick={handleToggleSelectMode}
            className={`p-1 sm:p-1.5 rounded-lg border transition-all flex items-center space-x-1 shrink-0 ${
              isSelectMode
                ? 'bg-amber-500/20 text-amber-500 dark:text-amber-300 border-amber-500/40 shadow-sm ring-1 ring-amber-500/30'
                : 'bg-white/[0.04] hover:bg-white/[0.08] text-slate-400 hover:text-white border border-white/[0.06]'
            }`}
            title={isSelectMode ? t('webTerminal.exitSelectMode', '退出选择') : t('webTerminal.selectMode', '划选模式')}
          >
            <TextSelect className="w-3.5 h-3.5" />
            <span className="text-[11px] hidden xl:inline">
              {isSelectMode ? t('webTerminal.exitSelectMode', '退出选择') : t('webTerminal.selectMode', '划选模式')}
            </span>
          </button>

          {/* Fullscreen / Standalone Toggle */}
          <button
            type="button"
            onClick={handleFullscreenToggle}
            className={`p-1 sm:p-1.5 rounded-lg border transition-all ${
              standalone
                ? 'hidden sm:inline-flex bg-indigo-500/20 text-indigo-300 border-indigo-500/30'
                : 'bg-white/[0.04] hover:bg-white/[0.08] text-slate-400 hover:text-white border border-white/[0.06]'
            }`}
            title={standalone ? t('webTerminal.exitFullscreen') : t('webTerminal.fullscreen')}
          >
            {standalone ? <Minimize2 className="w-3.5 h-3.5 text-indigo-400" /> : <Maximize2 className="w-3.5 h-3.5" />}
          </button>
        </div>
      </div>
      )}

      {/* Terminal Workspace Container */}
      <div
        style={!hideHeader && isMobile && standalone ? viewportStyle : undefined}
        className="flex-1 min-h-0 flex flex-col relative overflow-hidden"
      >
        {/* xterm.js Canvas Container */}
      <div
        onClick={() => {
          if (!isSelectModeRef.current) {
            xtermRef.current?.focus();
          }
        }}
        className={`flex-1 py-1.5 sm:py-2 pl-[max(0.5rem,env(safe-area-inset-left,0px))] pr-[max(0.5rem,env(safe-area-inset-right,0px))] bg-[var(--bg-canvas)] overflow-hidden min-h-0 relative ${
          isSelectMode ? 'cursor-crosshair select-none' : 'cursor-text'
        } ${isRefitting ? 'opacity-40 select-none pointer-events-none' : 'opacity-100'} transition-opacity duration-150`}
        style={{
          touchAction: isSelectMode ? 'none' : 'pan-y',
          userSelect: isSelectMode ? 'none' : undefined,
          WebkitUserSelect: isSelectMode ? 'none' : undefined,
        }}
      >
        {/* Floating Disconnect & Auto-Reconnect Toast */}
        {!isConnected && !isConnecting && reconnectCountdown > 0 && (
          <div className="absolute top-3 left-1/2 -translate-x-1/2 z-30 flex items-center space-x-2.5 px-3.5 py-1.5 rounded-xl bg-[#160E12]/95 border border-rose-500/40 text-rose-300 text-xs backdrop-blur-md shadow-2xl animate-in fade-in slide-in-from-top-2 select-none">
            <div className="relative flex items-center justify-center">
              <span className="w-2 h-2 rounded-full bg-rose-500" />
              <span className="absolute w-2 h-2 rounded-full bg-rose-500 animate-ping opacity-75" />
            </div>
            <span className="font-mono text-[11px]">
              {t('webTerminal.reconnectCountdown', { count: reconnectCountdown.toString() }).replace('{count}', reconnectCountdown.toString())}
            </span>
            <button
              type="button"
              onClick={handleManualReconnect}
              className="px-2 py-0.5 rounded-lg bg-rose-500/20 hover:bg-rose-500/30 active:scale-95 text-white font-medium text-[11px] transition-all border border-rose-500/30 flex items-center space-x-1"
            >
              <RefreshCw className="w-3 h-3 text-rose-300" />
              <span>{t('webTerminal.reconnectNow')}</span>
            </button>
          </div>
        )}

        {/* Selection Gesture Overlay: Decouples user gesture tracking from xterm character DOM rendering */}
        {isSelectMode && (
          <div
            className="selection-gesture-overlay absolute inset-0 z-20 cursor-crosshair touch-none select-none bg-transparent"
            onTouchStart={handleOverlayTouchStart}
            onTouchMove={handleOverlayTouchMove}
            onTouchEnd={handleOverlayTouchEnd}
            onTouchCancel={handleOverlayTouchEnd}
            onMouseDown={handleOverlayMouseDown}
            onMouseMove={handleOverlayMouseMove}
            onMouseUp={handleOverlayMouseUp}
          />
        )}

        {/* Mobile Touch Selection Magnifier Bubble */}
        {isSelectMode && magnifier.visible && (
          <div
            style={{ left: `${magnifier.x}px`, top: `${magnifier.y}px` }}
            className="fixed -translate-x-1/2 -translate-y-1/2 z-40 pointer-events-none select-none flex flex-col items-center animate-in fade-in zoom-in-95 duration-75"
          >
            {/* Inverted Pointer (Pointing up when flipped below finger) */}
            {magnifier.isFlippedBelow && (
              <div className="w-0 h-0 border-x-4 border-x-transparent border-b-4 border-b-indigo-500/60 mb-[-1px]" />
            )}

            {/* Magnifier Bubble Body */}
            <div className="px-2.5 py-1 rounded-xl bg-slate-900/95 dark:bg-slate-950/95 border border-indigo-500/40 shadow-2xl backdrop-blur-xl flex items-center font-mono text-xs sm:text-sm font-semibold tracking-wide whitespace-pre text-slate-400 ring-1 ring-white/10">
              <span>{magnifier.textBefore}</span>
              <span className="bg-indigo-600 text-white px-1 py-0.5 rounded shadow-sm scale-110 mx-0.5">
                {magnifier.focusChar === ' ' ? '␣' : magnifier.focusChar}
              </span>
              <span>{magnifier.textAfter}</span>
            </div>

            {/* Normal Pointer (Pointing down when positioned above finger) */}
            {!magnifier.isFlippedBelow && (
              <div className="w-0 h-0 border-x-4 border-x-transparent border-t-4 border-t-indigo-500/60 mt-[-1px]" />
            )}
          </div>
        )}

        {/* Floating Selection Mode Bar (Compact iOS-style Single-Line Capsule) */}
        {isSelectMode && (
          <div className="absolute top-2 left-1/2 -translate-x-1/2 z-30 flex items-center gap-1 sm:gap-1.5 px-2 py-1 rounded-2xl bg-[var(--bg-surface)]/95 border border-indigo-500/30 text-[var(--text-primary)] text-xs backdrop-blur-xl shadow-2xl animate-in fade-in slide-in-from-top-2 select-none whitespace-nowrap max-w-[95vw] overflow-x-auto no-scrollbar">
            {/* Status Icon Indicator */}
            <div className="flex items-center text-amber-500 dark:text-amber-400 font-semibold px-1 shrink-0" title={t('webTerminal.selectModeActive')}>
              <TextSelect className="w-3.5 h-3.5" />
            </div>

            <div className="h-3.5 w-[1px] bg-[var(--border-subtle)] shrink-0" />

            {/* Select Screen / All (Compact) */}
            <button
              type="button"
              onClick={handleSelectAll}
              title={t('webTerminal.selectAllVisible')}
              className="px-2 py-0.5 rounded-lg bg-black/[0.05] dark:bg-white/[0.08] hover:bg-black/[0.1] dark:hover:bg-white/[0.15] active:scale-95 text-[var(--text-primary)] text-[11px] font-medium transition-all shrink-0"
            >
              {t('webTerminal.selectAllShort', '全选')}
            </button>

            {/* Clear Selection (Visible when has selection) */}
            {hasSelection && (
              <button
                type="button"
                onClick={handleClearSelection}
                className="p-1 rounded-lg bg-black/[0.05] dark:bg-white/[0.08] hover:bg-rose-500/20 text-slate-400 hover:text-rose-300 active:scale-95 text-[11px] transition-all shrink-0"
                title={t('webTerminal.clearSelection')}
              >
                <X className="w-3 h-3" />
              </button>
            )}

            {/* Copy Button (Highlights and shows count when selected) */}
            <button
              type="button"
              disabled={!hasSelection}
              onClick={handleCopySelection}
              className={`px-2.5 py-0.5 rounded-lg text-[11px] font-semibold flex items-center space-x-1 transition-all shrink-0 ${
                hasSelection
                  ? 'bg-indigo-600 hover:bg-indigo-500 active:scale-95 text-white shadow-sm ring-1 ring-indigo-400/50 cursor-pointer'
                  : 'bg-black/[0.04] dark:bg-white/[0.05] text-slate-400 opacity-40 cursor-not-allowed'
              }`}
              title={t('webTerminal.copy')}
            >
              <Copy className="w-3 h-3" />
              <span>{t('webTerminal.copy')}</span>
              {hasSelection && selectedCharCount > 0 && (
                <span className="text-[10px] font-mono opacity-85">({selectedCharCount})</span>
              )}
            </button>

            {/* Done / Exit Select Mode */}
            <button
              type="button"
              onClick={handleExitSelectMode}
              className="px-2 py-0.5 rounded-lg bg-emerald-500/15 hover:bg-emerald-500/25 active:scale-95 text-emerald-600 dark:text-emerald-400 border border-emerald-500/30 flex items-center space-x-1 text-[11px] font-semibold transition-all shrink-0 cursor-pointer"
              title={t('webTerminal.done')}
            >
              <Check className="w-3 h-3 stroke-[2.5]" />
              <span>{t('webTerminal.done')}</span>
            </button>
          </div>
        )}

        {/* Floating Quick Action Toast */}
        {toastMessage && (
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-30 flex items-center space-x-1.5 px-3 py-1.5 rounded-xl bg-slate-900/90 dark:bg-slate-900/95 border border-white/10 text-white text-xs backdrop-blur-md shadow-2xl animate-in fade-in slide-in-from-bottom-2 pointer-events-none select-none">
            <Check className="w-3.5 h-3.5 text-emerald-400" />
            <span className="text-[11px] font-medium">{toastMessage}</span>
          </div>
        )}

        {/* Floating Scroll to Bottom Button */}
        {!isAtBottom && activeHostId && !isSelectMode && xtermRef.current?.buffer.active.type !== 'alternate' && (
          <button
            type="button"
            onClick={handleScrollToBottom}
            aria-label={t('webTerminal.scrollToBottom', '跳到最后')}
            title={t('webTerminal.scrollToBottom', '跳到最后')}
            className={`absolute right-4 z-20 w-9 h-9 rounded-full bg-[var(--bg-surface)]/85 hover:bg-[var(--bg-surface-hover)] border border-[var(--border-subtle)] shadow-xl flex items-center justify-center text-slate-300 hover:text-white transition-all active:scale-95 backdrop-blur-md cursor-pointer animate-in fade-in zoom-in-90 ${
              isMobile && !hideAccessoryBar ? 'bottom-14' : 'bottom-4'
            }`}
          >
            <ArrowDown className="w-4 h-4 text-indigo-400 animate-pulse" />
          </button>
        )}

        {/* Empty State Guard (Calm, flat placeholder matching File Manager) */}
        {!activeHostId && (
          <div className="absolute inset-0 z-20 flex flex-col items-center justify-center p-6 text-center select-none bg-[var(--bg-canvas)]">
            <div className="w-12 h-12 rounded-xl bg-white/[0.04] border border-white/[0.08] flex items-center justify-center text-slate-400 mb-3">
              <TerminalSquare className="w-6 h-6" />
            </div>
            <p className="text-sm font-medium text-[var(--text-secondary)] font-sans">
              {t('webTerminal.emptyState.title', '当前暂无在线终端节点')}
            </p>
            <p className="text-xs text-[var(--text-muted)] mt-1.5 max-w-sm leading-relaxed font-sans">
              {t('webTerminal.emptyState.desc', '系统采用纯反向 Agent 统一架构。请在宿主机或任意远程节点运行反向终端 Agent，建立安全连接后即可在此管理控制台与文件。')}
            </p>
            {onRequestAddNode && (
              <button
                type="button"
                onClick={onRequestAddNode}
                className="mt-4 px-3.5 py-1.5 rounded-lg bg-indigo-600/20 hover:bg-indigo-600/30 text-indigo-300 border border-indigo-500/30 text-xs font-medium flex items-center space-x-1.5 transition-all active:scale-95 cursor-pointer shadow-xs"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>{t('webTerminal.hostSelector.addNode', '接入内网新节点')}</span>
              </button>
            )}
          </div>
        )}

        <div
          ref={terminalContainerRef}
          className={`h-full w-full ${isSelectMode ? 'terminal-select-mode select-none cursor-crosshair' : 'cursor-text'}`}
          style={{
            touchAction: isSelectMode ? 'none' : undefined,
            userSelect: isSelectMode ? 'none' : undefined,
            WebkitUserSelect: isSelectMode ? 'none' : undefined,
            transform: cursorShiftY > 0 ? `translateY(-${cursorShiftY}px)` : undefined,
            transition: 'none',
          }}
        />
      </div>

      {/* Mobile Touch Accessory Bar */}
      {activeHostId && !hideAccessoryBar && (
      <TerminalAccessoryBar
        onSendInput={(data) => {
          handleSendInput(data, false);
          if (isCtrlActiveRef.current || isAltActiveRef.current || isShiftActiveRef.current) {
            setIsCtrlActive(false);
            setIsAltActive(false);
            setIsShiftActive(false);
            isCtrlActiveRef.current = false;
            isAltActiveRef.current = false;
            isShiftActiveRef.current = false;
          }
        }}
        isCtrlActive={isCtrlActive}
        onToggleCtrl={() => setIsCtrlActive(!isCtrlActive)}
        isAltActive={isAltActive}
        onToggleAlt={() => setIsAltActive(!isAltActive)}
        isShiftActive={isShiftActive}
        onToggleShift={() => setIsShiftActive(!isShiftActive)}
        onToggleKeyboard={handleToggleKeyboard}
        onHideKeyboard={handleHideKeyboard}
        isKeyboardOpen={isKeyboardOpen}
        hasSelection={hasSelection}
        isSelectMode={isSelectMode}
        onCopy={handleCopySelection}
        onPaste={handlePasteClipboard}
        onToggleSelectMode={handleToggleSelectMode}
      />
      )}
      </div>
    </div>
  );
});

export default WebTerminalView;

