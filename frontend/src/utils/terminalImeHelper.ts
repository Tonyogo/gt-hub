/**
 * Helper to handle mobile virtual keyboard direct input (e.g. digits, punctuation)
 * when in Chinese/Pinyin IME mode without breaking composition word selection.
 */

export interface TerminalImeOptions {
  textarea: HTMLTextAreaElement;
  onDirectInput: (data: string) => void;
}

export interface TerminalImeController {
  isComposing: () => boolean;
  dispose: () => void;
}

export function attachMobileImeHandler({
  textarea,
  onDirectInput,
}: TerminalImeOptions): TerminalImeController {
  let isComposing = false;
  let compositionEndTimer: ReturnType<typeof setTimeout> | null = null;
  let lastHandledData = '';
  let lastHandledTime = 0;
  let lastNonImeKeyDownTime = 0;

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.keyCode !== 229 && e.key !== 'Unidentified') {
      lastNonImeKeyDownTime = Date.now();
    }
  };

  const handleCompositionStart = () => {
    if (compositionEndTimer) {
      clearTimeout(compositionEndTimer);
      compositionEndTimer = null;
    }
    isComposing = true;
  };

  const handleCompositionEnd = () => {
    if (compositionEndTimer) {
      clearTimeout(compositionEndTimer);
    }
    // Delay resetting composing flag by 60ms to allow xterm's native
    // CompositionHelper._finalizeComposition to read and dispatch the selected word.
    compositionEndTimer = setTimeout(() => {
      isComposing = false;
      compositionEndTimer = null;
    }, 60);
  };

  const handleBeforeInput = (e: InputEvent) => {
    // If user is typing in composition mode (e.g. typing pinyin letters),
    // let xterm's native CompositionHelper manage candidate rendering and selection.
    if (isComposing) {
      return;
    }

    // If preceded by a physical (non-IME) keydown, let xterm process the input natively.
    if (Date.now() - lastNonImeKeyDownTime < 50) {
      return;
    }

    if (e.inputType === 'insertText' && e.data) {
      // Prevent xterm's internal _inputEvent from discarding the event via its
      // (!ev.composed || !this._keyDownSeen) check when keyCode 229 precedes it.
      if (e.cancelable) {
        e.preventDefault();
      }
      e.stopPropagation();

      lastHandledData = e.data;
      lastHandledTime = Date.now();

      textarea.value = '';
      onDirectInput(e.data);
    }
  };

  const handleInput = (e: Event) => {
    // Fallback for older mobile webviews where beforeinput cannot be canceled:
    // If not composing, and data wasn't just sent by beforeinput within 60ms, deliver it.
    if (isComposing) {
      return;
    }

    // If preceded by a physical (non-IME) keydown, let xterm process the input natively.
    if (Date.now() - lastNonImeKeyDownTime < 50) {
      return;
    }

    const inputEv = e as InputEvent;
    if (inputEv.inputType === 'insertText' && inputEv.data) {
      const now = Date.now();
      if (inputEv.data === lastHandledData && (now - lastHandledTime) < 60) {
        // Already handled by beforeinput
        textarea.value = '';
        return;
      }

      lastHandledData = inputEv.data;
      lastHandledTime = now;
      textarea.value = '';
      onDirectInput(inputEv.data);
    }
  };

  textarea.addEventListener('keydown', handleKeyDown as EventListener, { capture: true });
  textarea.addEventListener('compositionstart', handleCompositionStart);
  textarea.addEventListener('compositionend', handleCompositionEnd);
  textarea.addEventListener('beforeinput', handleBeforeInput as EventListener, { capture: true });
  textarea.addEventListener('input', handleInput as EventListener, { capture: true });

  return {
    isComposing: () => isComposing,
    dispose: () => {
      if (compositionEndTimer) {
        clearTimeout(compositionEndTimer);
        compositionEndTimer = null;
      }
      textarea.removeEventListener('keydown', handleKeyDown as EventListener, { capture: true });
      textarea.removeEventListener('compositionstart', handleCompositionStart);
      textarea.removeEventListener('compositionend', handleCompositionEnd);
      textarea.removeEventListener('beforeinput', handleBeforeInput as EventListener, { capture: true });
      textarea.removeEventListener('input', handleInput as EventListener, { capture: true });
    },
  };
}
