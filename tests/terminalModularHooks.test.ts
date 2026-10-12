import * as fs from 'fs';
import * as path from 'path';

describe('Modular Terminal Custom Hooks & Components Verification', () => {
  const wsHookPath = path.resolve(__dirname, '../frontend/src/components/terminal/hooks/useTerminalWebSocket.ts');
  const keyboardHookPath = path.resolve(__dirname, '../frontend/src/components/terminal/hooks/useMobileKeyboard.ts');
  const selectionHookPath = path.resolve(__dirname, '../frontend/src/components/terminal/hooks/useTerminalSelection.ts');
  const imeHookPath = path.resolve(__dirname, '../frontend/src/components/terminal/hooks/useTerminalIme.ts');
  const magnifierBubblePath = path.resolve(__dirname, '../frontend/src/components/terminal/components/TerminalMagnifierBubble.tsx');
  const selectionToolbarPath = path.resolve(__dirname, '../frontend/src/components/terminal/components/TerminalSelectionToolbar.tsx');
  const emptyStatePath = path.resolve(__dirname, '../frontend/src/components/terminal/components/TerminalEmptyState.tsx');

  let wsContent: string;
  let keyboardContent: string;
  let selectionContent: string;
  let imeContent: string;
  let magnifierContent: string;
  let selectionToolbarContent: string;
  let emptyStateContent: string;

  beforeAll(() => {
    wsContent = fs.readFileSync(wsHookPath, 'utf-8');
    keyboardContent = fs.readFileSync(keyboardHookPath, 'utf-8');
    selectionContent = fs.readFileSync(selectionHookPath, 'utf-8');
    imeContent = fs.readFileSync(imeHookPath, 'utf-8');
    magnifierContent = fs.readFileSync(magnifierBubblePath, 'utf-8');
    selectionToolbarContent = fs.readFileSync(selectionToolbarPath, 'utf-8');
    emptyStateContent = fs.readFileSync(emptyStatePath, 'utf-8');
  });

  describe('useTerminalWebSocket', () => {
    it('manages WebSocket connection, ping keepalive, and reconnect backoff', () => {
      expect(wsContent).toContain('export function useTerminalWebSocket');
      expect(wsContent).toContain("wsRef.current.send(`JSON:${JSON.stringify({ type: 'ping' })}`)");
      expect(wsContent).toContain('reconnectAttemptRef');
      expect(wsContent).toContain('clearReconnectTimers');
      expect(wsContent).toContain('clearPingInterval');
      expect(wsContent).toContain('sendResize');
      expect(wsContent).toContain('sendInput');
    });
  });

  describe('useMobileKeyboard', () => {
    it('manages virtual keyboard translateY, cursorShiftY, and viewportStyle', () => {
      expect(keyboardContent).toContain('export function useMobileKeyboard');
      expect(keyboardContent).toContain('updateCursorShift');
      expect(keyboardContent).toContain('handleHideKeyboard');
      expect(keyboardContent).toContain('handleToggleKeyboard');
      expect(keyboardContent).toContain('cursorShiftY');
      expect(keyboardContent).toContain('baseHeightRef');
      expect(keyboardContent).toContain('baseWidthRef');
    });
  });

  describe('useTerminalSelection', () => {
    it('manages selection mode, magnifier, copy, and paste interactions', () => {
      expect(selectionContent).toContain('export function useTerminalSelection');
      expect(selectionContent).toContain('handleCopySelection');
      expect(selectionContent).toContain('handlePasteClipboard');
      expect(selectionContent).toContain('handleToggleSelectMode');
      expect(selectionContent).toContain('handleSelectAll');
      expect(selectionContent).toContain('handleClearSelection');
      expect(selectionContent).toContain('updateMagnifierFromTouch');
      expect(selectionContent).toContain('applyOverlaySelection');
    });
  });

  describe('useTerminalIme', () => {
    it('attaches mobile IME handler and manages input attributes', () => {
      expect(imeContent).toContain('export function useTerminalIme');
      expect(imeContent).toContain('attachMobileImeHandler');
      expect(imeContent).toContain("enterkeyhint', 'done'");
      expect(imeContent).toContain('disposeIme');
    });
  });

  describe('Presentational Components', () => {
    it('implements TerminalMagnifierBubble, TerminalSelectionToolbar, and TerminalEmptyState', () => {
      expect(magnifierContent).toContain('TerminalMagnifierBubble');
      expect(magnifierContent).toContain('focusChar');
      expect(magnifierContent).toContain('isFlippedBelow');

      expect(selectionToolbarContent).toContain('TerminalSelectionToolbar');
      expect(selectionToolbarContent).toContain('selectAllShort');
      expect(selectionToolbarContent).toContain('onCopySelection');

      expect(emptyStateContent).toContain('TerminalEmptyState');
      expect(emptyStateContent).toContain('onRequestAddNode');
    });
  });
});
