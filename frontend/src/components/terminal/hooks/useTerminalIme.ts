import { useRef, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { attachMobileImeHandler, TerminalImeController } from '../../../utils/terminalImeHelper';

export interface UseTerminalImeOptions {
  terminalContainerRef: React.RefObject<HTMLDivElement | null>;
  xtermRef: React.RefObject<Terminal | null>;
  isMountedRef: React.RefObject<boolean>;
  onFocus: () => void;
  onBlur: () => void;
}

export interface UseTerminalImeReturn {
  attachIme: (textarea: HTMLTextAreaElement) => void;
  disposeIme: () => void;
}

export function useTerminalIme({
  xtermRef,
  isMountedRef,
  onFocus,
  onBlur,
}: UseTerminalImeOptions): UseTerminalImeReturn {
  const imeControllerRef = useRef<TerminalImeController | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const attachIme = useCallback(
    (helperTextarea: HTMLTextAreaElement) => {
      textareaRef.current = helperTextarea;

      helperTextarea.setAttribute('autocapitalize', 'none');
      helperTextarea.setAttribute('autocomplete', 'off');
      helperTextarea.setAttribute('autocorrect', 'off');
      helperTextarea.setAttribute('spellcheck', 'false');
      helperTextarea.setAttribute('tabindex', '0');
      helperTextarea.setAttribute('aria-label', 'Terminal input');
      helperTextarea.setAttribute('enterkeyhint', 'done');

      helperTextarea.addEventListener('focus', onFocus);
      helperTextarea.addEventListener('blur', onBlur);

      imeControllerRef.current = attachMobileImeHandler({
        textarea: helperTextarea,
        onDirectInput: (data) => {
          if (!isMountedRef.current || !xtermRef.current) return;
          xtermRef.current.input(data, true);
        },
      });
    },
    [onFocus, onBlur, isMountedRef, xtermRef]
  );

  const disposeIme = useCallback(() => {
    if (textareaRef.current) {
      textareaRef.current.removeEventListener('focus', onFocus);
      textareaRef.current.removeEventListener('blur', onBlur);
      textareaRef.current = null;
    }
    if (imeControllerRef.current) {
      imeControllerRef.current.dispose();
      imeControllerRef.current = null;
    }
  }, [onFocus, onBlur]);

  return {
    attachIme,
    disposeIme,
  };
}
