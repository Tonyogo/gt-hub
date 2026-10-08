const IGNORED_KEYS = new Set([
  'Shift',
  'Control',
  'Alt',
  'Meta',
  'CapsLock',
  'NumLock',
  'ScrollLock',
  'ContextMenu',
  'Unidentified'
]);

export function calculateAnsiModifier(ctrl: boolean, alt: boolean, shift: boolean): number {
  let mod = 1;
  if (shift) mod += 1;
  if (alt) mod += 2;
  if (ctrl) mod += 4;
  return mod;
}

export function encodeNavigationKey(
  key: 'PageUp' | 'PageDown' | 'Home' | 'End' | 'Delete' | 'Del' | 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight' | string,
  ctrl: boolean = false,
  alt: boolean = false,
  shift: boolean = false
): string {
  const mod = calculateAnsiModifier(ctrl, alt, shift);
  const isModified = mod > 1;

  if (key === 'PageUp') {
    return isModified ? `\x1b[5;${mod}~` : '\x1b[5~';
  }
  if (key === 'PageDown') {
    return isModified ? `\x1b[6;${mod}~` : '\x1b[6~';
  }
  if (key === 'Home') {
    return isModified ? `\x1b[1;${mod}H` : '\x1b[H';
  }
  if (key === 'End') {
    return isModified ? `\x1b[1;${mod}F` : '\x1b[F';
  }
  if (key === 'Delete' || key === 'Del') {
    return isModified ? `\x1b[3;${mod}~` : '\x1b[3~';
  }

  const arrowCodes: Record<string, string> = {
    ArrowUp: 'A',
    ArrowDown: 'B',
    ArrowRight: 'C',
    ArrowLeft: 'D',
  };

  const code = arrowCodes[key];
  if (code) {
    return isModified ? `\x1b[1;${mod}${code}` : `\x1b[${code}`;
  }

  return '';
}

export function encodeModifierKey(
  event: { key: string; code?: string; shiftKey?: boolean },
  ctrl: boolean,
  alt: boolean,
  shift: boolean = false
): string | null {
  const effectiveShift = shift || !!event.shiftKey;
  if (!ctrl && !alt && !effectiveShift) {
    return null;
  }

  const { key } = event;
  if (!key || IGNORED_KEYS.has(key)) {
    return null;
  }

  // 1. Arrow & Navigation Keys with Modifier
  if (
    key === 'PageUp' ||
    key === 'PageDown' ||
    key === 'Home' ||
    key === 'End' ||
    key === 'Delete' ||
    key === 'Del' ||
    key.startsWith('Arrow')
  ) {
    const seq = encodeNavigationKey(key, ctrl, alt, effectiveShift);
    return seq || null;
  }

  // 2. Tab with Shift
  if (key === 'Tab') {
    if (effectiveShift) {
      return alt ? '\x1b\x1b[Z' : '\x1b[Z';
    }
    if (ctrl) return alt ? '\x1b\t' : '\t';
    if (alt) return '\x1b\t';
  }

  // 3. Letters (a-z, A-Z)
  if (/^[a-zA-Z]$/.test(key)) {
    let base = effectiveShift ? key.toUpperCase() : key;
    if (ctrl) {
      const charCode = key.toUpperCase().charCodeAt(0);
      base = String.fromCharCode((charCode - 64) & 0x1F);
    }
    return alt ? `\x1b${base}` : base;
  }

  // 3. CTRL + Numbers & Special Control Symbols
  if (ctrl) {
    switch (key) {
      case '@':
      case '2':
      case ' ':
        return alt ? '\x1b\x00' : '\x00';
      case '[':
      case '3':
      case 'Escape':
        return alt ? '\x1b\x1b' : '\x1b';
      case '\\':
      case '4':
        return alt ? '\x1b\x1c' : '\x1c';
      case ']':
      case '5':
        return alt ? '\x1b\x1d' : '\x1d';
      case '^':
      case '6':
        return alt ? '\x1b\x1e' : '\x1e';
      case '_':
      case '-':
      case '7':
        return alt ? '\x1b\x1f' : '\x1f';
      case '?':
      case '8':
        return alt ? '\x1b\x7f' : '\x7f';
      case 'Backspace':
        return alt ? '\x1b\x08' : '\x08';
      case 'Enter':
        return alt ? '\x1b\n' : '\n';
      case 'Tab':
        return alt ? '\x1b\t' : '\t';
      default:
        break;
    }
  }

  // 4. ALT + other character
  if (alt) {
    if (key === 'Enter') return '\x1b\r';
    if (key === 'Tab') return '\x1b\t';
    if (key === 'Backspace') return '\x1b\x7f';
    if (key.length === 1) return `\x1b${key}`;
  }

  return null;
}
