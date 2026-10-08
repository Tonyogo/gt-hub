import {
  calculateAnsiModifier,
  encodeNavigationKey,
  encodeModifierKey,
} from '../frontend/src/utils/terminalKeyEncoder';

describe('terminalKeyEncoder', () => {
  describe('calculateAnsiModifier', () => {
    it('calculates standard ANSI 1-8 modifier codes correctly', () => {
      // 1: None
      expect(calculateAnsiModifier(false, false, false)).toBe(1);
      // 2: Shift
      expect(calculateAnsiModifier(false, false, true)).toBe(2);
      // 3: Alt
      expect(calculateAnsiModifier(false, true, false)).toBe(3);
      // 4: Shift + Alt
      expect(calculateAnsiModifier(false, true, true)).toBe(4);
      // 5: Ctrl
      expect(calculateAnsiModifier(true, false, false)).toBe(5);
      // 6: Shift + Ctrl
      expect(calculateAnsiModifier(true, false, true)).toBe(6);
      // 7: Ctrl + Alt
      expect(calculateAnsiModifier(true, true, false)).toBe(7);
      // 8: Shift + Ctrl + Alt
      expect(calculateAnsiModifier(true, true, true)).toBe(8);
    });
  });

  describe('encodeNavigationKey', () => {
    it('encodes unmodified navigation keys', () => {
      expect(encodeNavigationKey('PageUp')).toBe('\x1b[5~');
      expect(encodeNavigationKey('PageDown')).toBe('\x1b[6~');
      expect(encodeNavigationKey('Home')).toBe('\x1b[H');
      expect(encodeNavigationKey('End')).toBe('\x1b[F');
      expect(encodeNavigationKey('Delete')).toBe('\x1b[3~');
      expect(encodeNavigationKey('Del')).toBe('\x1b[3~');
      expect(encodeNavigationKey('ArrowUp')).toBe('\x1b[A');
      expect(encodeNavigationKey('ArrowDown')).toBe('\x1b[B');
      expect(encodeNavigationKey('ArrowRight')).toBe('\x1b[C');
      expect(encodeNavigationKey('ArrowLeft')).toBe('\x1b[D');
    });

    it('encodes navigation keys with Shift modifier', () => {
      expect(encodeNavigationKey('PageUp', false, false, true)).toBe('\x1b[5;2~');
      expect(encodeNavigationKey('PageDown', false, false, true)).toBe('\x1b[6;2~');
      expect(encodeNavigationKey('Home', false, false, true)).toBe('\x1b[1;2H');
      expect(encodeNavigationKey('End', false, false, true)).toBe('\x1b[1;2F');
      expect(encodeNavigationKey('Delete', false, false, true)).toBe('\x1b[3;2~');
      expect(encodeNavigationKey('Del', false, false, true)).toBe('\x1b[3;2~');
      expect(encodeNavigationKey('ArrowUp', false, false, true)).toBe('\x1b[1;2A');
      expect(encodeNavigationKey('ArrowDown', false, false, true)).toBe('\x1b[1;2B');
      expect(encodeNavigationKey('ArrowRight', false, false, true)).toBe('\x1b[1;2C');
      expect(encodeNavigationKey('ArrowLeft', false, false, true)).toBe('\x1b[1;2D');
    });

    it('encodes navigation keys with Ctrl and Alt modifiers', () => {
      expect(encodeNavigationKey('PageUp', true, false, false)).toBe('\x1b[5;5~');
      expect(encodeNavigationKey('PageDown', false, true, false)).toBe('\x1b[6;3~');
      expect(encodeNavigationKey('Home', true, false, false)).toBe('\x1b[1;5H');
      expect(encodeNavigationKey('End', false, true, false)).toBe('\x1b[1;3F');
      expect(encodeNavigationKey('Delete', true, false, false)).toBe('\x1b[3;5~');
      expect(encodeNavigationKey('Del', true, true, true)).toBe('\x1b[3;8~');
      expect(encodeNavigationKey('PageUp', true, false, true)).toBe('\x1b[5;6~');
      expect(encodeNavigationKey('PageDown', true, true, true)).toBe('\x1b[6;8~');
      expect(encodeNavigationKey('ArrowUp', true, false, false)).toBe('\x1b[1;5A');
      expect(encodeNavigationKey('ArrowDown', false, true, false)).toBe('\x1b[1;3B');
      expect(encodeNavigationKey('ArrowLeft', true, true, false)).toBe('\x1b[1;7D');
      expect(encodeNavigationKey('ArrowRight', true, true, true)).toBe('\x1b[1;8C');
    });

    it('returns empty string for unrecognized keys', () => {
      expect(encodeNavigationKey('InvalidKey')).toBe('');
    });
  });

  describe('encodeModifierKey', () => {
    it('returns null when no virtual modifiers are active', () => {
      expect(encodeModifierKey({ key: 'c' }, false, false)).toBeNull();
      expect(encodeModifierKey({ key: 'c' }, false, false, false)).toBeNull();
    });

    it('ignores modifier keys alone (Shift, Control, Alt, Meta)', () => {
      expect(encodeModifierKey({ key: 'Shift' }, true, false)).toBeNull();
      expect(encodeModifierKey({ key: 'Control' }, true, false)).toBeNull();
      expect(encodeModifierKey({ key: 'Alt' }, true, false)).toBeNull();
      expect(encodeModifierKey({ key: 'Meta' }, false, true)).toBeNull();
      expect(encodeModifierKey({ key: 'Shift' }, false, false, true)).toBeNull();
    });

    it('encodes CTRL + letter to control character (\\x01 - \\x1a)', () => {
      expect(encodeModifierKey({ key: 'a' }, true, false)).toBe('\x01');
      expect(encodeModifierKey({ key: 'c' }, true, false)).toBe('\x03');
      expect(encodeModifierKey({ key: 'd' }, true, false)).toBe('\x04');
      expect(encodeModifierKey({ key: 'z' }, true, false)).toBe('\x1a');
      expect(encodeModifierKey({ key: 'C' }, true, false)).toBe('\x03');
    });

    it('encodes ALT + letter to ESC + letter', () => {
      expect(encodeModifierKey({ key: 'b' }, false, true)).toBe('\x1bb');
      expect(encodeModifierKey({ key: 'f' }, false, true)).toBe('\x1bf');
      expect(encodeModifierKey({ key: 'd' }, false, true)).toBe('\x1bd');
    });

    it('encodes CTRL + ALT + letter to ESC + control char', () => {
      expect(encodeModifierKey({ key: 'a' }, true, true)).toBe('\x1b\x01');
      expect(encodeModifierKey({ key: 'c' }, true, true)).toBe('\x1b\x03');
    });

    it('encodes Shift + letter to uppercase letter', () => {
      expect(encodeModifierKey({ key: 'a' }, false, false, true)).toBe('A');
      expect(encodeModifierKey({ key: 'z' }, false, false, true)).toBe('Z');
    });

    it('encodes Shift + Tab to backtab (\\x1b[Z)', () => {
      expect(encodeModifierKey({ key: 'Tab' }, false, false, true)).toBe('\x1b[Z');
      expect(encodeModifierKey({ key: 'Tab', shiftKey: true }, false, false)).toBe('\x1b[Z');
    });

    it('encodes PageUp, PageDown, Home, End, Delete with modifiers', () => {
      expect(encodeModifierKey({ key: 'PageUp' }, false, false, true)).toBe('\x1b[5;2~');
      expect(encodeModifierKey({ key: 'PageDown' }, false, false, true)).toBe('\x1b[6;2~');
      expect(encodeModifierKey({ key: 'PageUp' }, true, false, false)).toBe('\x1b[5;5~');
      expect(encodeModifierKey({ key: 'PageDown' }, false, true, false)).toBe('\x1b[6;3~');
      expect(encodeModifierKey({ key: 'Home' }, true, false, false)).toBe('\x1b[1;5H');
      expect(encodeModifierKey({ key: 'End' }, false, true, false)).toBe('\x1b[1;3F');
      expect(encodeModifierKey({ key: 'Home' }, false, false, true)).toBe('\x1b[1;2H');
      expect(encodeModifierKey({ key: 'Delete' }, true, false, false)).toBe('\x1b[3;5~');
      expect(encodeModifierKey({ key: 'Delete' }, false, false, true)).toBe('\x1b[3;2~');
    });

    it('encodes CTRL + number / special symbol characters', () => {
      expect(encodeModifierKey({ key: '2' }, true, false)).toBe('\x00');
      expect(encodeModifierKey({ key: '@' }, true, false)).toBe('\x00');
      expect(encodeModifierKey({ key: '[' }, true, false)).toBe('\x1b');
      expect(encodeModifierKey({ key: '\\' }, true, false)).toBe('\x1c');
      expect(encodeModifierKey({ key: ']' }, true, false)).toBe('\x1d');
      expect(encodeModifierKey({ key: '^' }, true, false)).toBe('\x1e');
      expect(encodeModifierKey({ key: '_' }, true, false)).toBe('\x1f');
      expect(encodeModifierKey({ key: '?' }, true, false)).toBe('\x7f');
      expect(encodeModifierKey({ key: 'Backspace' }, true, false)).toBe('\x08');
    });

    it('encodes arrow keys with modifiers', () => {
      expect(encodeModifierKey({ key: 'ArrowUp' }, true, false)).toBe('\x1b[1;5A');
      expect(encodeModifierKey({ key: 'ArrowDown' }, true, false)).toBe('\x1b[1;5B');
      expect(encodeModifierKey({ key: 'ArrowRight' }, false, true)).toBe('\x1b[1;3C');
      expect(encodeModifierKey({ key: 'ArrowLeft' }, true, true)).toBe('\x1b[1;7D');
      expect(encodeModifierKey({ key: 'ArrowUp' }, false, false, true)).toBe('\x1b[1;2A');
      expect(encodeModifierKey({ key: 'ArrowDown' }, true, false, true)).toBe('\x1b[1;6B');
    });
  });
});
