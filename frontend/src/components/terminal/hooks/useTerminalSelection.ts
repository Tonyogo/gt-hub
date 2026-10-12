import { useState, useRef, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { calculateMagnifierPosition, extractMagnifierSlice } from '../../../utils/terminalMagnifierHelper';

export interface MagnifierState {
  visible: boolean;
  x: number;
  y: number;
  textBefore: string;
  focusChar: string;
  textAfter: string;
  isFlippedBelow: boolean;
}

export interface UseTerminalSelectionOptions {
  terminalContainerRef: React.RefObject<HTMLDivElement | null>;
  xtermRef: React.RefObject<Terminal | null>;
  showToast: (msg: string) => void;
  t: (key: string, fallback?: string) => string;
  onSendInput: (data: string, shouldFocus?: boolean) => void;
  onHideKeyboard: () => void;
  onSelectModeChange?: (isSelect: boolean) => void;
}

export interface UseTerminalSelectionReturn {
  isSelectMode: boolean;
  setIsSelectMode: (mode: boolean | ((prev: boolean) => boolean)) => void;
  isSelectModeRef: React.MutableRefObject<boolean>;
  hasSelection: boolean;
  setHasSelection: (has: boolean) => void;
  selectedCharCount: number;
  setSelectedCharCount: (count: number) => void;
  magnifier: MagnifierState;
  setMagnifier: React.Dispatch<React.SetStateAction<MagnifierState>>;
  handleToggleSelectMode: () => void;
  handleCopySelection: () => void;
  handlePasteClipboard: () => Promise<void>;
  handleSelectAll: () => void;
  handleClearSelection: () => void;
  handleExitSelectMode: () => void;
  getOverlayCellCoords: (clientX: number, clientY: number) => { col: number; viewportRow: number; bufferRow: number } | null;
  applyOverlaySelection: (start: { col: number; bufferRow: number }, current: { col: number; bufferRow: number }) => void;
  updateMagnifierFromTouch: (clientX: number, clientY: number) => void;
  handleOverlayTouchStart: (e: React.TouchEvent<HTMLDivElement>) => void;
  handleOverlayTouchMove: (e: React.TouchEvent<HTMLDivElement>) => void;
  handleOverlayTouchEnd: () => void;
  handleOverlayMouseDown: (e: React.MouseEvent<HTMLDivElement>) => void;
  handleOverlayMouseMove: (e: React.MouseEvent<HTMLDivElement>) => void;
  handleOverlayMouseUp: () => void;
}

export function useTerminalSelection({
  terminalContainerRef,
  xtermRef,
  showToast,
  t,
  onSendInput,
  onHideKeyboard,
  onSelectModeChange,
}: UseTerminalSelectionOptions): UseTerminalSelectionReturn {
  const [hasSelection, setHasSelection] = useState<boolean>(false);
  const [selectedCharCount, setSelectedCharCount] = useState<number>(0);
  const [isSelectMode, setIsSelectMode] = useState<boolean>(false);
  const isSelectModeRef = useRef<boolean>(false);
  isSelectModeRef.current = isSelectMode;

  const [magnifier, setMagnifier] = useState<MagnifierState>({
    visible: false,
    x: 0,
    y: 0,
    textBefore: '',
    focusChar: ' ',
    textAfter: '',
    isFlippedBelow: false,
  });

  const overlaySelectionStartRef = useRef<{ col: number; viewportRow: number; bufferRow: number } | null>(null);
  const isOverlayMouseSelectingRef = useRef<boolean>(false);
  const overlayMouseStartRef = useRef<{ col: number; bufferRow: number } | null>(null);

  const getOverlayCellCoords = useCallback(
    (clientX: number, clientY: number) => {
      const container = terminalContainerRef.current;
      const term = xtermRef.current;
      if (!container || !term) return null;

      const screenEl = (container.querySelector('.xterm-screen') as HTMLElement) || container;
      if (!screenEl) return null;
      const rect = screenEl.getBoundingClientRect();
      const relativeX = clientX - rect.left;
      const relativeY = clientY - rect.top;

      const renderService = (term as any)._core?._renderService;
      const cellWidth = renderService?.dimensions?.css?.cell?.width || rect.width / term.cols;
      const cellHeight = renderService?.dimensions?.css?.cell?.height || rect.height / term.rows;

      const col = Math.max(0, Math.min(term.cols - 1, Math.floor(relativeX / cellWidth)));
      const viewportRow = Math.max(0, Math.min(term.rows - 1, Math.floor(relativeY / cellHeight)));
      const bufferRow = term.buffer.active.viewportY + viewportRow;

      return { col, viewportRow, bufferRow };
    },
    [terminalContainerRef, xtermRef]
  );

  const updateMagnifierFromTouch = useCallback(
    (clientX: number, clientY: number) => {
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
    },
    [getOverlayCellCoords, xtermRef]
  );

  const applyOverlaySelection = useCallback(
    (start: { col: number; bufferRow: number }, current: { col: number; bufferRow: number }) => {
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
    },
    [xtermRef]
  );

  const handleCopySelection = useCallback(() => {
    const text = xtermRef.current?.getSelection();
    if (text) {
      const doCopy = () => {
        showToast(t('webTerminal.copiedToClipboard'));
        setIsSelectMode(false);
        isSelectModeRef.current = false;
        setMagnifier((prev) => ({ ...prev, visible: false }));
        xtermRef.current?.clearSelection();
        setHasSelection(false);
        setSelectedCharCount(0);
      };

      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard
          .writeText(text)
          .then(doCopy)
          .catch(() => {
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
            } catch {}
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
        } catch {}
        doCopy();
      }
    }
  }, [showToast, t, xtermRef]);

  const handlePasteClipboard = useCallback(async () => {
    let clipText = '';

    if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.readText) {
      try {
        clipText = await navigator.clipboard.readText();
      } catch (err) {
        console.warn('[WebTerminal] Clipboard readText failed, falling back to prompt:', err);
      }
    }

    if (!clipText && typeof window !== 'undefined') {
      const manualInput = window.prompt(t('webTerminal.pastePromptTip', '请长按粘贴文字：'));
      if (manualInput) {
        clipText = manualInput;
      }
    }

    if (!clipText) {
      return;
    }

    onSendInput(clipText, false);
    if (xtermRef.current) {
      xtermRef.current.focus();
    }
  }, [onSendInput, t, xtermRef]);

  const handleToggleSelectMode = useCallback(() => {
    setIsSelectMode((prev) => {
      const next = !prev;
      isSelectModeRef.current = next;
      if (next) {
        onHideKeyboard();
        showToast(t('webTerminal.selectModeTip'));
      }
      return next;
    });
  }, [onHideKeyboard, showToast, t]);

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
  }, [xtermRef]);

  const handleClearSelection = useCallback(() => {
    if (xtermRef.current) {
      xtermRef.current.clearSelection();
      setHasSelection(false);
      setSelectedCharCount(0);
    }
  }, [xtermRef]);

  const handleExitSelectMode = useCallback(() => {
    setIsSelectMode(false);
    isSelectModeRef.current = false;
    setMagnifier((prev) => ({ ...prev, visible: false }));
    handleClearSelection();
  }, [handleClearSelection]);

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
    setMagnifier((prev) => ({ ...prev, visible: false }));
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
      const text = xtermRef.current?.getSelection();
      if (text && text.trim().length > 0) {
        handleCopySelection();
      }
    }
  };

  return {
    isSelectMode,
    setIsSelectMode,
    isSelectModeRef,
    hasSelection,
    setHasSelection,
    selectedCharCount,
    setSelectedCharCount,
    magnifier,
    setMagnifier,
    handleToggleSelectMode,
    handleCopySelection,
    handlePasteClipboard,
    handleSelectAll,
    handleClearSelection,
    handleExitSelectMode,
    getOverlayCellCoords,
    applyOverlaySelection,
    updateMagnifierFromTouch,
    handleOverlayTouchStart,
    handleOverlayTouchMove,
    handleOverlayTouchEnd,
    handleOverlayMouseDown,
    handleOverlayMouseMove,
    handleOverlayMouseUp,
  };
}
