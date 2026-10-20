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

export function isModifierKey(e: KeyboardEvent): boolean {
  return (
    e.keyCode === 16 || // Shift
    e.keyCode === 17 || // Control
    e.keyCode === 18 || // Alt
    e.keyCode === 20 || // CapsLock
    e.keyCode === 91 || // Meta Left / OS
    e.keyCode === 92 || // Meta Right
    e.keyCode === 93 || // Meta
    e.keyCode === 225 || // AltGraph
    e.key === 'Shift' ||
    e.key === 'Control' ||
    e.key === 'Alt' ||
    e.key === 'CapsLock' ||
    e.key === 'Meta' ||
    e.key === 'Fn' ||
    e.key === 'AltGraph' ||
    e.key === 'OS' ||
    (e as any).code === 'CapsLock' ||
    (e as any).code === 'ShiftLeft' ||
    (e as any).code === 'ShiftRight' ||
    (e as any).code === 'ControlLeft' ||
    (e as any).code === 'ControlRight' ||
    (e as any).code === 'AltLeft' ||
    (e as any).code === 'AltRight' ||
    (e as any).code === 'MetaLeft' ||
    (e as any).code === 'MetaRight' ||
    (e as any).code === 'Fn'
  );
}

/**
 * Patches xterm.js CompositionHelper to prevent premature composition finalization
 * and duplicate input when switching between Chinese and English (especially via CapsLock or Shift).
 * Addresses xterm.js PR #5282 where CapsLock (keyCode 20) and modifier keys were not treated as
 * non-finalizing modifiers during composition, and ensures stale Chinese text in textarea.value
 * is purged immediately upon composition finalization so subsequent English input does not duplicate.
 */
export function patchCompositionHelper(term: any): void {
  if (!term) return;

  const compHelper = term?._core?._compositionHelper;
  if (compHelper && typeof compHelper.keydown === 'function') {
    if ((compHelper as any).__imePatched) {
      return;
    }
    (compHelper as any).__imePatched = true;

    const origKeydown = compHelper.keydown.bind(compHelper);
    compHelper.keydown = function (ev: KeyboardEvent): boolean {
      if (compHelper._isComposing || compHelper.isComposing || (compHelper as any)._isSendingComposition) {
        if (isModifierKey(ev)) {
          return false;
        }
      }
      return origKeydown(ev);
    };

    if (typeof compHelper._finalizeComposition === 'function') {
      const origFinalize = compHelper._finalizeComposition.bind(compHelper);
      compHelper._finalizeComposition = function (waitForPropagation: boolean) {
        if (waitForPropagation) {
          origFinalize(true);
          setTimeout(() => {
            if (!compHelper._isComposing) {
              if (compHelper._textarea) {
                compHelper._textarea.value = '';
              }
              if (compHelper._compositionPosition) {
                compHelper._compositionPosition.start = 0;
                compHelper._compositionPosition.end = 0;
              }
              compHelper._dataAlreadySent = '';
            }
          }, 0);
        } else {
          origFinalize(false);
          if (!compHelper._isComposing) {
            if (compHelper._textarea) {
              compHelper._textarea.value = '';
            }
            if (compHelper._compositionPosition) {
              compHelper._compositionPosition.start = 0;
              compHelper._compositionPosition.end = 0;
            }
            compHelper._dataAlreadySent = '';
          }
        }
      };
    }
    return;
  }

  // If term._core._compositionHelper is not yet initialized (e.g. called before term.open()),
  // hook term.open so it patches CompositionHelper immediately upon initialization.
  if (typeof term.open === 'function' && !(term as any).__openPatchedForIme) {
    (term as any).__openPatchedForIme = true;
    const origOpen = term.open.bind(term);
    term.open = function (...args: any[]) {
      const res = origOpen(...args);
      patchCompositionHelper(term);
      return res;
    };
  }
}

export function attachMobileImeHandler({
  textarea,
  onDirectInput,
}: TerminalImeOptions): TerminalImeController {
  let isComposing = false;
  let compositionEndTimer: ReturnType<typeof setTimeout> | null = null;
  let lastHandledData = '';
  let lastHandledTime = 0;
  let pendingBeforeInputDedupe = false;
  let lastNonImeKeyDownTime = 0;

  const handleKeyDown = (e: KeyboardEvent) => {
    pendingBeforeInputDedupe = false;
    if (isModifierKey(e)) {
      // Modifier keys (CapsLock, Shift, Meta, etc.) switch input method modes
      // and do not produce characters. They must not unlock the composition grace window
      // or be registered as physical character keydowns.
      return;
    }
    if (e.keyCode !== 229 && e.key !== 'Unidentified') {
      lastNonImeKeyDownTime = Date.now();
      if (compositionEndTimer) {
        clearTimeout(compositionEndTimer);
        compositionEndTimer = null;
        isComposing = false;
        textarea.value = '';
      }
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
    // CompositionHelper._finalizeComposition to read and dispatch the selected word,
    // unless a physical keydown arrives earlier.
    compositionEndTimer = setTimeout(() => {
      isComposing = false;
      compositionEndTimer = null;
      textarea.value = '';
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
      pendingBeforeInputDedupe = true;

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
      if (pendingBeforeInputDedupe && inputEv.data === lastHandledData && (now - lastHandledTime) < 60) {
        // Consume the single paired input event corresponding to the preceding beforeinput
        pendingBeforeInputDedupe = false;
        textarea.value = '';
        return;
      }

      pendingBeforeInputDedupe = false;
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
