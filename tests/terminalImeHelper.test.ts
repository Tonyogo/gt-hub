import {
  attachMobileImeHandler,
  isModifierKey,
  patchCompositionHelper,
} from '../frontend/src/utils/terminalImeHelper';

class MockTextArea extends EventTarget {
  value = '';
  parentNode: any = null;
}

if (typeof document === 'undefined') {
  (global as any).document = {
    createElement: (_tag: string) => {
      return new MockTextArea() as any;
    },
    body: {
      appendChild: (el: any) => {
        el.parentNode = (global as any).document.body;
        return el;
      },
      removeChild: (el: any) => {
        el.parentNode = null;
        return el;
      },
    },
  };
}

describe('terminalImeHelper', () => {
  let textarea: HTMLTextAreaElement;
  let sentData: string[];

  beforeEach(() => {
    textarea = document.createElement('textarea');
    document.body.appendChild(textarea);
    sentData = [];
  });

  afterEach(() => {
    if (textarea.parentNode) {
      textarea.parentNode.removeChild(textarea);
    }
    jest.useRealTimers();
  });

  test('intercepts beforeinput insertText when not composing and sends data', () => {
    const controller = attachMobileImeHandler({
      textarea,
      onDirectInput: (data: string) => sentData.push(data),
    });

    expect(controller.isComposing()).toBe(false);

    // Simulate mobile virtual keyboard direct numeric input (e.g. '1')
    const beforeInputEv = new CustomEvent('beforeinput', {
      cancelable: true,
      bubbles: true,
    }) as any;
    beforeInputEv.inputType = 'insertText';
    beforeInputEv.data = '1';

    let defaultPrevented = false;
    beforeInputEv.preventDefault = () => { defaultPrevented = true; };

    textarea.dispatchEvent(beforeInputEv);

    expect(sentData).toEqual(['1']);
    expect(defaultPrevented).toBe(true);

    controller.dispose();
  });

  test('does not intercept beforeinput when preceded by physical keydown', () => {
    const controller = attachMobileImeHandler({
      textarea,
      onDirectInput: (data: string) => sentData.push(data),
    });

    const keyDownEv = new CustomEvent('keydown', { bubbles: true, cancelable: true }) as any;
    keyDownEv.keyCode = 49;
    keyDownEv.key = '1';
    textarea.dispatchEvent(keyDownEv);

    const beforeInputEv = new CustomEvent('beforeinput', {
      cancelable: true,
      bubbles: true,
    }) as any;
    beforeInputEv.inputType = 'insertText';
    beforeInputEv.data = '1';

    let defaultPrevented = false;
    beforeInputEv.preventDefault = () => { defaultPrevented = true; };

    textarea.dispatchEvent(beforeInputEv);

    expect(sentData).toEqual([]);
    expect(defaultPrevented).toBe(false);

    controller.dispose();
  });

  test('intercepts beforeinput when preceded by virtual IME keydown (keyCode 229)', () => {
    const controller = attachMobileImeHandler({
      textarea,
      onDirectInput: (data: string) => sentData.push(data),
    });

    const keyDownEv = new CustomEvent('keydown', { bubbles: true, cancelable: true }) as any;
    keyDownEv.keyCode = 229;
    keyDownEv.key = 'Unidentified';
    textarea.dispatchEvent(keyDownEv);

    const beforeInputEv = new CustomEvent('beforeinput', {
      cancelable: true,
      bubbles: true,
    }) as any;
    beforeInputEv.inputType = 'insertText';
    beforeInputEv.data = '1';

    let defaultPrevented = false;
    beforeInputEv.preventDefault = () => { defaultPrevented = true; };

    textarea.dispatchEvent(beforeInputEv);

    expect(sentData).toEqual(['1']);
    expect(defaultPrevented).toBe(true);

    controller.dispose();
  });

  test('does not intercept fallback input when preceded by physical keydown', () => {
    const controller = attachMobileImeHandler({
      textarea,
      onDirectInput: (data: string) => sentData.push(data),
    });

    const keyDownEv = new CustomEvent('keydown', { bubbles: true, cancelable: true }) as any;
    keyDownEv.keyCode = 49;
    keyDownEv.key = '1';
    textarea.dispatchEvent(keyDownEv);

    const inputEv = new CustomEvent('input') as any;
    inputEv.inputType = 'insertText';
    inputEv.data = '1';
    textarea.dispatchEvent(inputEv);

    expect(sentData).toEqual([]);

    controller.dispose();
  });

  test('intercepts beforeinput if physical keydown happened more than 50ms ago', () => {
    jest.useFakeTimers();
    const controller = attachMobileImeHandler({
      textarea,
      onDirectInput: (data: string) => sentData.push(data),
    });

    const keyDownEv = new CustomEvent('keydown', { bubbles: true, cancelable: true }) as any;
    keyDownEv.keyCode = 49;
    keyDownEv.key = '1';
    textarea.dispatchEvent(keyDownEv);

    jest.advanceTimersByTime(60);

    const beforeInputEv = new CustomEvent('beforeinput', {
      cancelable: true,
      bubbles: true,
    }) as any;
    beforeInputEv.inputType = 'insertText';
    beforeInputEv.data = '2';

    let defaultPrevented = false;
    beforeInputEv.preventDefault = () => { defaultPrevented = true; };

    textarea.dispatchEvent(beforeInputEv);

    expect(sentData).toEqual(['2']);
    expect(defaultPrevented).toBe(true);

    controller.dispose();
  });

  test('does not intercept beforeinput during composition', () => {
    const controller = attachMobileImeHandler({
      textarea,
      onDirectInput: (data: string) => sentData.push(data),
    });

    // Start composition (e.g. typing pinyin)
    textarea.dispatchEvent(new Event('compositionstart'));
    expect(controller.isComposing()).toBe(true);

    const beforeInputEv = new CustomEvent('beforeinput', {
      cancelable: true,
      bubbles: true,
    }) as any;
    beforeInputEv.inputType = 'insertText';
    beforeInputEv.data = 'n';

    let defaultPrevented = false;
    beforeInputEv.preventDefault = () => { defaultPrevented = true; };

    textarea.dispatchEvent(beforeInputEv);

    // Should NOT intercept while composing (leave to xterm CompositionHelper)
    expect(sentData).toEqual([]);
    expect(defaultPrevented).toBe(false);

    controller.dispose();
  });

  test('delays resetting isComposing after compositionend to let xterm finalize word', () => {
    jest.useFakeTimers();
    const controller = attachMobileImeHandler({
      textarea,
      onDirectInput: (data: string) => sentData.push(data),
    });

    textarea.dispatchEvent(new Event('compositionstart'));
    expect(controller.isComposing()).toBe(true);

    textarea.dispatchEvent(new Event('compositionend'));
    // Immediately after compositionend, isComposing should still remain true for a short window
    expect(controller.isComposing()).toBe(true);

    // Advance timers past the finalization delay (e.g. 60ms)
    jest.advanceTimersByTime(70);
    expect(controller.isComposing()).toBe(false);

    controller.dispose();
  });

  test('new compositionstart resets pending compositionEndTimer', () => {
    jest.useFakeTimers();
    const controller = attachMobileImeHandler({
      textarea,
      onDirectInput: (data: string) => sentData.push(data),
    });

    textarea.dispatchEvent(new Event('compositionstart'));
    textarea.dispatchEvent(new Event('compositionend'));
    expect(controller.isComposing()).toBe(true);

    // Before timer expires, new composition starts
    jest.advanceTimersByTime(30);
    textarea.dispatchEvent(new Event('compositionstart'));
    expect(controller.isComposing()).toBe(true);

    // Advance 50ms (total 80ms since first compositionend)
    jest.advanceTimersByTime(50);
    // Should still be composing because new composition canceled the old timer
    expect(controller.isComposing()).toBe(true);

    controller.dispose();
  });

  test('deduplicates input event if preceded by beforeinput with same data within 60ms', () => {
    const controller = attachMobileImeHandler({
      textarea,
      onDirectInput: (data: string) => sentData.push(data),
    });

    const beforeInputEv = new CustomEvent('beforeinput', { cancelable: true }) as any;
    beforeInputEv.inputType = 'insertText';
    beforeInputEv.data = '5';
    textarea.dispatchEvent(beforeInputEv);

    const inputEv = new CustomEvent('input') as any;
    inputEv.inputType = 'insertText';
    inputEv.data = '5';
    textarea.dispatchEvent(inputEv);

    expect(sentData).toEqual(['5']);

    controller.dispose();
  });

  test('handles fallback input event if beforeinput was not fired', () => {
    const controller = attachMobileImeHandler({
      textarea,
      onDirectInput: (data: string) => sentData.push(data),
    });

    const inputEv = new CustomEvent('input') as any;
    inputEv.inputType = 'insertText';
    inputEv.data = '2';
    textarea.dispatchEvent(inputEv);

    expect(sentData).toEqual(['2']);

    controller.dispose();
  });

  test('ignores input event during composition', () => {
    const controller = attachMobileImeHandler({
      textarea,
      onDirectInput: (data: string) => sentData.push(data),
    });

    textarea.dispatchEvent(new Event('compositionstart'));

    const inputEv = new CustomEvent('input') as any;
    inputEv.inputType = 'insertText';
    inputEv.data = 'a';
    textarea.dispatchEvent(inputEv);

    expect(sentData).toEqual([]);

    controller.dispose();
  });

  test('dispose removes event listeners and cancels pending timers', () => {
    jest.useFakeTimers();
    const controller = attachMobileImeHandler({
      textarea,
      onDirectInput: (data: string) => sentData.push(data),
    });

    textarea.dispatchEvent(new Event('compositionstart'));
    textarea.dispatchEvent(new Event('compositionend'));

    controller.dispose();

    jest.advanceTimersByTime(100);

    // Further events should not trigger callback
    const beforeInputEv = new CustomEvent('beforeinput', { cancelable: true }) as any;
    beforeInputEv.inputType = 'insertText';
    beforeInputEv.data = '9';
    textarea.dispatchEvent(beforeInputEv);

    expect(sentData).toEqual([]);
  });

  describe('isModifierKey', () => {
    test('correctly identifies Shift, Control, Alt, CapsLock, and Meta keys', () => {
      expect(isModifierKey({ keyCode: 16 } as KeyboardEvent)).toBe(true);
      expect(isModifierKey({ keyCode: 17 } as KeyboardEvent)).toBe(true);
      expect(isModifierKey({ keyCode: 18 } as KeyboardEvent)).toBe(true);
      expect(isModifierKey({ keyCode: 20 } as KeyboardEvent)).toBe(true);
      expect(isModifierKey({ keyCode: 91 } as KeyboardEvent)).toBe(true);
      expect(isModifierKey({ keyCode: 92 } as KeyboardEvent)).toBe(true);
      expect(isModifierKey({ keyCode: 93 } as KeyboardEvent)).toBe(true);
      expect(isModifierKey({ key: 'CapsLock' } as KeyboardEvent)).toBe(true);
      expect(isModifierKey({ key: 'Shift' } as KeyboardEvent)).toBe(true);
      expect(isModifierKey({ key: 'Meta' } as KeyboardEvent)).toBe(true);
      expect(isModifierKey({ code: 'CapsLock' } as any)).toBe(true);

      // Non-modifiers
      expect(isModifierKey({ keyCode: 13, key: 'Enter' } as KeyboardEvent)).toBe(false);
      expect(isModifierKey({ keyCode: 65, key: 'a' } as KeyboardEvent)).toBe(false);
      expect(isModifierKey({ keyCode: 229, key: 'Unidentified' } as KeyboardEvent)).toBe(false);
    });
  });

  describe('Chinese to English switch and CapsLock protection', () => {
    test('does NOT unlock composition when CapsLock or Shift is pressed during the 60ms grace window', () => {
      jest.useFakeTimers();
      const controller = attachMobileImeHandler({
        textarea,
        onDirectInput: (data: string) => sentData.push(data),
      });

      textarea.dispatchEvent(new Event('compositionstart'));
      textarea.dispatchEvent(new Event('compositionend'));
      expect(controller.isComposing()).toBe(true);

      // User presses CapsLock 15ms after compositionend (switching Chinese to English)
      jest.advanceTimersByTime(15);
      const kdCaps = new CustomEvent('keydown') as any;
      kdCaps.keyCode = 20;
      kdCaps.key = 'CapsLock';
      textarea.dispatchEvent(kdCaps);

      // Should still remain composing during grace window
      expect(controller.isComposing()).toBe(true);

      // User presses Shift 15ms later
      jest.advanceTimersByTime(15);
      const kdShift = new CustomEvent('keydown') as any;
      kdShift.keyCode = 16;
      kdShift.key = 'Shift';
      textarea.dispatchEvent(kdShift);

      expect(controller.isComposing()).toBe(true);

      // After grace window passes (60ms total)
      jest.advanceTimersByTime(40);
      expect(controller.isComposing()).toBe(false);

      controller.dispose();
    });

    test('clears textarea.value after compositionEndTimer expires to prevent stale Chinese characters', () => {
      jest.useFakeTimers();
      const controller = attachMobileImeHandler({
        textarea,
        onDirectInput: (data: string) => sentData.push(data),
      });

      textarea.value = '你好';
      textarea.dispatchEvent(new Event('compositionstart'));
      textarea.dispatchEvent(new Event('compositionend'));

      // Still has value during the 60ms window so xterm can finalize
      expect(textarea.value).toBe('你好');

      // Advance timers past 60ms
      jest.advanceTimersByTime(70);
      expect(controller.isComposing()).toBe(false);
      // Cleared after composition finalized
      expect(textarea.value).toBe('');

      controller.dispose();
    });

    test('clears textarea.value when physical keydown arrives during grace window', () => {
      jest.useFakeTimers();
      const controller = attachMobileImeHandler({
        textarea,
        onDirectInput: (data: string) => sentData.push(data),
      });

      textarea.value = '你好';
      textarea.dispatchEvent(new Event('compositionstart'));
      textarea.dispatchEvent(new Event('compositionend'));

      jest.advanceTimersByTime(10);
      const kd = new CustomEvent('keydown') as any;
      kd.keyCode = 13;
      kd.key = 'Enter';
      textarea.dispatchEvent(kd);

      expect(controller.isComposing()).toBe(false);
      expect(textarea.value).toBe('');

      controller.dispose();
    });
  });

  describe('patchCompositionHelper', () => {
    test('intercepts CapsLock and modifier keys during composition and returns false without premature finalization', () => {
      let origKeydownCalled = false;
      const mockCompHelper = {
        _isComposing: true,
        _isSendingComposition: false,
        keydown: jest.fn((_ev: KeyboardEvent) => {
          origKeydownCalled = true;
          return false;
        }),
      };
      const mockTerm = {
        _core: {
          _compositionHelper: mockCompHelper,
        },
      };

      patchCompositionHelper(mockTerm as any);

      // CapsLock during composition
      const evCaps = { keyCode: 20, key: 'CapsLock' } as KeyboardEvent;
      const resCaps = mockCompHelper.keydown(evCaps);
      expect(resCaps).toBe(false);
      expect(origKeydownCalled).toBe(false);

      // Shift during composition
      const evShift = { keyCode: 16, key: 'Shift' } as KeyboardEvent;
      const resShift = mockCompHelper.keydown(evShift);
      expect(resShift).toBe(false);
      expect(origKeydownCalled).toBe(false);

      // Meta during composition
      const evMeta = { keyCode: 91, key: 'Meta' } as KeyboardEvent;
      const resMeta = mockCompHelper.keydown(evMeta);
      expect(resMeta).toBe(false);
      expect(origKeydownCalled).toBe(false);

      // Regular key during composition (e.g. Enter) should call original keydown
      const evEnter = { keyCode: 13, key: 'Enter' } as KeyboardEvent;
      mockCompHelper.keydown(evEnter);
      expect(origKeydownCalled).toBe(true);
    });

    test('intercepts CapsLock when _isSendingComposition is true', () => {
      let origKeydownCalled = false;
      const mockCompHelper = {
        _isComposing: false,
        _isSendingComposition: true,
        keydown: jest.fn((_ev: KeyboardEvent) => {
          origKeydownCalled = true;
          return false;
        }),
      };
      const mockTerm = {
        _core: {
          _compositionHelper: mockCompHelper,
        },
      };

      patchCompositionHelper(mockTerm as any);

      const evCaps = { keyCode: 20, key: 'CapsLock' } as KeyboardEvent;
      const resCaps = mockCompHelper.keydown(evCaps);
      expect(resCaps).toBe(false);
      expect(origKeydownCalled).toBe(false);
    });

    test('safely ignores term if _compositionHelper is missing or not a function', () => {
      expect(() => patchCompositionHelper(null)).not.toThrow();
      expect(() => patchCompositionHelper({})).not.toThrow();
      expect(() => patchCompositionHelper({ _core: {} })).not.toThrow();
    });
  });
});
