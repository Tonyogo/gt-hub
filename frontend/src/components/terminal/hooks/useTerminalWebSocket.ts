import { useState, useRef, useCallback, useEffect } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { isSyntheticTerminalReport, isUnsolicitedShellDeviceReport } from '../../../utils/terminalFilter';
import { shouldScrollToBottom, scrollToBottomSafe } from '../../../utils/terminalScrollHelper';
import { requestAuthTicket } from '../../../utils/apiClient';

export interface UseTerminalWebSocketOptions {
  adminKey: string;
  activeHostId: string;
  paneId?: 'main' | 'split';
  xtermRef: React.RefObject<Terminal | null>;
  fitAddonRef: React.RefObject<FitAddon | null>;
  isMountedRef: React.RefObject<boolean>;
  isAtBottomRef: React.RefObject<boolean>;
  isRefittingRef: React.RefObject<boolean>;
  isMobileRef: React.RefObject<boolean>;
  safeFit: (forceResize?: boolean) => boolean;
  onConnectionChange?: (status: { isConnected: boolean; isConnecting: boolean }) => void;
  onPaneExit?: () => void;
}

export interface UseTerminalWebSocketReturn {
  isConnected: boolean;
  isConnecting: boolean;
  reconnectCountdown: number;
  wsRef: React.RefObject<WebSocket | null>;
  lastSentColsRef: React.MutableRefObject<number>;
  lastSentRowsRef: React.MutableRefObject<number>;
  hasFirstDataFittedRef: React.MutableRefObject<boolean>;
  isReplayingRef: React.MutableRefObject<boolean>;
  pingIntervalRef: React.MutableRefObject<NodeJS.Timeout | null>;
  clearPingInterval: () => void;
  clearReconnectTimers: () => void;
  initWebSocket: () => void;
  handleManualReconnect: () => void;
  executeReset: () => void;
  sendResize: (cols: number, rows: number, force?: boolean) => void;
  sendInput: (data: string, shouldFocus?: boolean) => void;
}

export function useTerminalWebSocket({
  adminKey,
  activeHostId,
  paneId = 'main',
  xtermRef,
  fitAddonRef,
  isMountedRef,
  isAtBottomRef,
  isRefittingRef,
  isMobileRef,
  safeFit,
  onConnectionChange,
  onPaneExit,
}: UseTerminalWebSocketOptions): UseTerminalWebSocketReturn {
  const [isConnected, setIsConnected] = useState<boolean>(false);
  const [isConnecting, setIsConnecting] = useState<boolean>(true);
  const [reconnectCountdown, setReconnectCountdown] = useState<number>(0);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectAttemptRef = useRef<number>(0);
  const countdownIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const isProcessExitedRef = useRef<boolean>(false);
  const isReplayingRef = useRef<boolean>(true);
  const replayTimerRef = useRef<NodeJS.Timeout | null>(null);
  const hasFirstDataFittedRef = useRef<boolean>(false);
  const lastSentColsRef = useRef<number>(0);
  const lastSentRowsRef = useRef<number>(0);
  const pingIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const connectSeqRef = useRef<number>(0);
  const lastPongTimeRef = useRef<number>(Date.now());
  const onPaneExitRef = useRef(onPaneExit);
  useEffect(() => {
    onPaneExitRef.current = onPaneExit;
  }, [onPaneExit]);

  const clearPingInterval = useCallback(() => {
    if (pingIntervalRef.current) {
      clearInterval(pingIntervalRef.current);
      pingIntervalRef.current = null;
    }
  }, []);

  const clearReconnectTimers = useCallback(() => {
    if (countdownIntervalRef.current) {
      clearInterval(countdownIntervalRef.current);
      countdownIntervalRef.current = null;
    }
    clearPingInterval();
    setReconnectCountdown(0);
  }, [clearPingInterval]);

  const sendResize = useCallback(
    (cols: number, rows: number, force: boolean = false) => {
      if (cols <= 0 || rows <= 0) return;
      if (!force && cols === lastSentColsRef.current && rows === lastSentRowsRef.current) {
        return;
      }

      const isMobileDevice = isMobileRef?.current || (typeof window !== 'undefined' && (window.innerWidth < 768 || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)));
      if (isMobileDevice && !force && lastSentRowsRef.current > 0) {
        const isWidthUnchanged = Math.abs(cols - lastSentColsRef.current) <= 2;
        const isHeightShrunk = rows < lastSentRowsRef.current;
        const isKeyboardActive = (
          typeof window !== 'undefined' && window.visualViewport && window.visualViewport.height < window.innerHeight * 0.85
        );
        if (isWidthUnchanged && (isHeightShrunk || isKeyboardActive)) {
          return;
        }
      }

      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        lastSentColsRef.current = cols;
        lastSentRowsRef.current = rows;
        wsRef.current.send(`JSON:${JSON.stringify({ type: 'resize', cols, rows })}`);
      }
    },
    [isMobileRef]
  );

  const initWebSocket = useCallback(() => {
    const currentSeq = ++connectSeqRef.current;
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

    if (!activeHostId) {
      setIsConnecting(false);
      setIsConnected(false);
      return;
    }

    setIsConnecting(true);
    setIsConnected(false);

    (async () => {
      const ticket = adminKey ? await requestAuthTicket(adminKey) : null;
      if (!isMountedRef.current || currentSeq !== connectSeqRef.current) return;

      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const host = window.location.host;
      const ticketParam = ticket ? `ticket=${encodeURIComponent(ticket)}` : (adminKey ? `x-admin-key=${encodeURIComponent(adminKey)}` : '');
      const paneParam = paneId && paneId !== 'main' ? `&paneId=${encodeURIComponent(paneId)}` : '';
      const wsUrl = `${protocol}//${host}/api/terminal/ws?${ticketParam ? ticketParam + '&' : ''}hostId=${encodeURIComponent(activeHostId)}${paneParam}`;

      const ws = new WebSocket(wsUrl);
      ws.binaryType = 'arraybuffer';
      wsRef.current = ws;

      ws.onopen = () => {
        lastPongTimeRef.current = Date.now();
        setIsConnecting(false);
        setIsConnected(true);
        reconnectAttemptRef.current = 0;
        clearReconnectTimers();
        clearPingInterval();

        pingIntervalRef.current = setInterval(() => {
          if (Date.now() - lastPongTimeRef.current > 35000) {
            console.warn('[WebTerminal] Heartbeat pong timeout (>35s), closing stale WebSocket');
            clearPingInterval();
            try {
              wsRef.current?.close(4000, 'Heartbeat pong timeout');
            } catch {}
            triggerReconnect();
            return;
          }
          if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
            try {
              wsRef.current.send(`JSON:${JSON.stringify({ type: 'ping' })}`);
            } catch {}
          }
        }, 15000);

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
        lastPongTimeRef.current = Date.now();
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
              if (parsed.type === 'agent_offline') {
                try {
                  ws.close(1012, 'Agent disconnected');
                } catch {}
                return;
              }
              if (parsed.type === 'pane_exit') {
                isProcessExitedRef.current = true;
                setIsConnected(false);
                setIsConnecting(false);
                clearReconnectTimers();
                onPaneExitRef.current?.();
                return;
              }
              if (parsed.type === 'pong') {
                return;
              }
            if (parsed.type === 'reset') {
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
          } catch {}
        }
        const wasAtBottom = isAtBottomRef.current;
        term?.write(data, () => {
          if (
            !isRefittingRef.current &&
            shouldScrollToBottom({
              isReplaying: isReplayingRef.current,
              wasAtBottom,
              bufferType: term?.buffer.active.type,
            })
          ) {
            scrollToBottomSafe(term);
          }
          if (isReplayingRef.current) {
            term?.refresh(0, Math.max(0, (term.rows || 1) - 1));
            isReplayingRef.current = false;
          }
        });
      } else if (data instanceof ArrayBuffer) {
        const wasAtBottom = isAtBottomRef.current;
        term?.write(new Uint8Array(data), () => {
          if (
            !isRefittingRef.current &&
            shouldScrollToBottom({
              isReplaying: isReplayingRef.current,
              wasAtBottom,
              bufferType: term?.buffer.active.type,
            })
          ) {
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

    ws.onerror = (_err) => {
      clearPingInterval();
    };
    })();
  }, [activeHostId, adminKey, clearReconnectTimers, clearPingInterval, safeFit, sendResize, xtermRef, fitAddonRef, isMountedRef, isAtBottomRef, isRefittingRef]);

  const handleManualReconnect = useCallback(() => {
    reconnectAttemptRef.current = 0;
    initWebSocket();
  }, [initWebSocket]);

  const executeReset = useCallback(() => {
    lastSentColsRef.current = 0;
    lastSentRowsRef.current = 0;
    reconnectAttemptRef.current = 0;
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(`JSON:${JSON.stringify({ type: 'reset' })}`);
    }
    xtermRef.current?.clear();
    xtermRef.current?.reset();
  }, [xtermRef]);

  const sendInput = useCallback(
    (data: string, shouldFocus = false) => {
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(data);
      }
      if (shouldFocus) {
        xtermRef.current?.focus();
      }
      scrollToBottomSafe(xtermRef.current);
    },
    [xtermRef]
  );

  return {
    isConnected,
    isConnecting,
    reconnectCountdown,
    wsRef,
    lastSentColsRef,
    lastSentRowsRef,
    hasFirstDataFittedRef,
    isReplayingRef,
    pingIntervalRef,
    clearPingInterval,
    clearReconnectTimers,
    initWebSocket,
    handleManualReconnect,
    executeReset,
    sendResize,
    sendInput,
  };
}
