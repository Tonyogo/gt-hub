import fs from 'fs';
import path from 'path';
import {
  patchCompositionHelper,
  isModifierKey,
  attachMobileImeHandler,
} from '../frontend/src/utils/terminalImeHelper';

class MockTextArea extends EventTarget {
  value = '';
  parentNode: any = null;
}

function createMockTextarea(): HTMLTextAreaElement {
  return new MockTextArea() as unknown as HTMLTextAreaElement;
}

describe('Terminal Chinese to English Switch Duplicate Input Fix', () => {
  describe('1. Static Code Analysis in WebTerminalView & useTerminalIme', () => {
    const webTerminalViewPath = path.resolve(
      __dirname,
      '../frontend/src/components/WebTerminalView.tsx'
    );
    const useTerminalImePath = path.resolve(
      __dirname,
      '../frontend/src/components/terminal/hooks/useTerminalIme.ts'
    );

    test('WebTerminalView imports and invokes patchCompositionHelper on term', () => {
      const content = fs.readFileSync(webTerminalViewPath, 'utf-8');
      expect(content).toContain('patchCompositionHelper');
      expect(content).toMatch(/term\.open\([^)]+\);\s*patchCompositionHelper\(term\);/);
    });

    test('WebTerminalView attachCustomKeyEventHandler suppresses CapsLock', () => {
      const content = fs.readFileSync(webTerminalViewPath, 'utf-8');
      expect(content).toContain("domEvent.key === 'CapsLock'");
      expect(content).toContain('domEvent.keyCode === 20');
      // Returns false for CapsLock to avoid spurious xterm data events or premature finalization
      expect(content).toMatch(/domEvent\.keyCode\s*===\s*20\s*\|\|\s*domEvent\.key\s*===\s*'CapsLock'/);
    });

    test('useTerminalIme invokes patchCompositionHelper on xtermRef.current', () => {
      const content = fs.readFileSync(useTerminalImePath, 'utf-8');
      expect(content).toContain('patchCompositionHelper');
      expect(content).toContain('patchCompositionHelper(xtermRef.current);');
    });
  });

  describe('2. CapsLock Premature Finalization Elimination (PR #5282 behavior)', () => {
    test('unpatched CompositionHelper prematurely finalizes on CapsLock (demonstrating the original bug)', () => {
      let finalizeCalls = 0;
      const unpatchedHelper = {
        _isComposing: true,
        _isSendingComposition: false,
        _finalizeComposition: (waitForPropagation: boolean) => {
          finalizeCalls++;
        },
        keydown(ev: KeyboardEvent): boolean {
          if (this._isComposing || this._isSendingComposition) {
            if (ev.keyCode === 229) {
              return false;
            }
            if (ev.keyCode === 16 || ev.keyCode === 17 || ev.keyCode === 18) {
              return false;
            }
            // Bug: CapsLock (keyCode 20) falls through here and finalizes prematurely!
            this._finalizeComposition(false);
          }
          return true;
        },
      };

      // Press CapsLock while typing pinyin in unpatched helper
      const evCaps = { keyCode: 20, key: 'CapsLock' } as KeyboardEvent;
      unpatchedHelper.keydown(evCaps);

      // Prematurely finalized (1st time)
      expect(finalizeCalls).toBe(1);

      // When browser finishes composition, compositionend fires and finalizes 2nd time -> duplicate!
      unpatchedHelper._finalizeComposition(true);
      expect(finalizeCalls).toBe(2);
    });

    test('patched CompositionHelper suppresses premature finalization on CapsLock and modifier keys', () => {
      let finalizeCalls = 0;
      const compHelper = {
        _isComposing: true,
        _isSendingComposition: false,
        _finalizeComposition: (waitForPropagation: boolean) => {
          finalizeCalls++;
        },
        keydown(ev: KeyboardEvent): boolean {
          if (this._isComposing || this._isSendingComposition) {
            if (ev.keyCode === 229) {
              return false;
            }
            if (ev.keyCode === 16 || ev.keyCode === 17 || ev.keyCode === 18) {
              return false;
            }
            this._finalizeComposition(false);
          }
          return true;
        },
      };
      const mockTerm = {
        _core: {
          _compositionHelper: compHelper,
        },
      };

      patchCompositionHelper(mockTerm as any);

      // Press CapsLock while typing pinyin
      const evCaps = { keyCode: 20, key: 'CapsLock' } as KeyboardEvent;
      const res = compHelper.keydown(evCaps);

      expect(res).toBe(false);
      // CapsLock did NOT trigger premature finalization!
      expect(finalizeCalls).toBe(0);

      // Then compositionend fires naturally
      compHelper._isComposing = false;
      compHelper._finalizeComposition(true);

      // Finalized exactly ONCE!
      expect(finalizeCalls).toBe(1);
    });
  });

  describe('3. Clean Slate Textarea & Grace Window on Input Method Switch', () => {
    test('cleans lingering Chinese text from textarea so subsequent English keystrokes do not duplicate', () => {
      jest.useFakeTimers();
      const textarea = createMockTextarea();
      const sent: string[] = [];
      const controller = attachMobileImeHandler({
        textarea,
        onDirectInput: (d) => sent.push(d),
      });

      // 1. User types Chinese: "你好"
      textarea.value = '你好';
      textarea.dispatchEvent(new Event('compositionstart'));
      textarea.dispatchEvent(new Event('compositionend'));

      // 2. User immediately switches to English (presses CapsLock)
      const evCaps = new CustomEvent('keydown') as any;
      evCaps.keyCode = 20;
      evCaps.key = 'CapsLock';
      textarea.dispatchEvent(evCaps);

      // Composition state preserved during 60ms grace window
      expect(controller.isComposing()).toBe(true);

      // 3. Grace window expires (60ms)
      jest.advanceTimersByTime(70);
      expect(controller.isComposing()).toBe(false);
      // Textarea is emptied of Chinese characters
      expect(textarea.value).toBe('');

      // 4. Now user types English letters (e.g. 'l')
      const bi = new CustomEvent('beforeinput', { cancelable: true }) as any;
      bi.inputType = 'insertText';
      bi.data = 'l';
      textarea.dispatchEvent(bi);

      expect(sent).toEqual(['l']);
      expect(textarea.value).toBe('');

      controller.dispose();
      jest.useRealTimers();
    });
  });

  describe('4. _finalizeComposition Stale Text Cleanup & Deferred Patching', () => {
    test('patchCompositionHelper wraps term.open if called before term.open()', () => {
      let openCalled = false;
      const fakeHelper = {
        _isComposing: false,
        _isSendingComposition: false,
        keydown: jest.fn((_ev?: any) => true),
        _finalizeComposition: jest.fn(),
      };
      const fakeTerm: any = {
        _core: {},
        open(container: any) {
          openCalled = true;
          this._core._compositionHelper = fakeHelper;
          return container;
        },
      };

      // Call patchCompositionHelper before open
      patchCompositionHelper(fakeTerm);
      expect((fakeTerm._core as any)._compositionHelper).toBeUndefined();

      // Now call open
      fakeTerm.open({});
      expect(openCalled).toBe(true);
      expect((fakeHelper as any).__imePatched).toBe(true);

      // Verify keydown was patched
      const res = fakeHelper.keydown({ keyCode: 20, key: 'CapsLock' } as any);
      // Not composing, so falls through to orig
      expect(res).toBe(true);
    });

    test('_finalizeComposition purges _textarea.value and resets compositionPosition on async completion', () => {
      jest.useFakeTimers();
      const mockCompHelper: any = {
        _isComposing: true,
        _isSendingComposition: false,
        _compositionPosition: { start: 0, end: 6 },
        _dataAlreadySent: '你好',
        _textarea: { value: '你好' },
        _coreService: { triggerDataEvent: jest.fn() },
        _finalizeComposition(waitForPropagation: boolean) {
          this._isComposing = false;
          if (waitForPropagation) {
            this._isSendingComposition = true;
            setTimeout(() => {
              if (this._isSendingComposition) {
                this._isSendingComposition = false;
                this._coreService.triggerDataEvent('你好', true);
              }
            }, 0);
          } else {
            this._isSendingComposition = false;
            this._coreService.triggerDataEvent('你好', true);
          }
        },
        keydown: jest.fn(() => true),
      };
      const mockTerm = { _core: { _compositionHelper: mockCompHelper } };
      patchCompositionHelper(mockTerm as any);

      // Finalize with propagation
      mockCompHelper._finalizeComposition(true);
      expect(mockCompHelper._textarea.value).toBe('你好');

      // Flush microtasks / timers
      jest.advanceTimersByTime(10);
      expect(mockCompHelper._coreService.triggerDataEvent).toHaveBeenCalledWith('你好', true);
      // Cleaned up after sending!
      expect(mockCompHelper._textarea.value).toBe('');
      expect(mockCompHelper._compositionPosition).toEqual({ start: 0, end: 0 });
      expect(mockCompHelper._dataAlreadySent).toBe('');

      jest.useRealTimers();
    });

    test('_finalizeComposition does not purge _textarea.value if a new composition has started', () => {
      jest.useFakeTimers();
      const mockCompHelper: any = {
        _isComposing: true,
        _isSendingComposition: false,
        _compositionPosition: { start: 0, end: 6 },
        _dataAlreadySent: '',
        _textarea: { value: '你好' },
        _coreService: { triggerDataEvent: jest.fn() },
        _finalizeComposition(waitForPropagation: boolean) {
          this._isComposing = false;
          if (waitForPropagation) {
            this._isSendingComposition = true;
            setTimeout(() => {
              if (this._isSendingComposition) {
                this._isSendingComposition = false;
                this._coreService.triggerDataEvent('你好', true);
              }
            }, 0);
          }
        },
        keydown: jest.fn(() => true),
      };
      const mockTerm = { _core: { _compositionHelper: mockCompHelper } };
      patchCompositionHelper(mockTerm as any);

      mockCompHelper._finalizeComposition(true);

      // A new composition starts before the timeout finishes
      mockCompHelper._isComposing = true;
      mockCompHelper._textarea.value = '世界';

      jest.advanceTimersByTime(10);
      // The new composition text is NOT wiped!
      expect(mockCompHelper._textarea.value).toBe('世界');

      jest.useRealTimers();
    });
  });
});
