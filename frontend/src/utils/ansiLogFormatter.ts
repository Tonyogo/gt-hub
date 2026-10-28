export interface AnsiLogSegment {
  text: string;
  colorClass?: string;
  bold?: boolean;
}

const ANSI_COLOR_MAP: Record<number, string> = {
  30: 'text-slate-400',
  31: 'text-rose-400',
  32: 'text-emerald-400',
  33: 'text-amber-400',
  34: 'text-sky-400',
  35: 'text-purple-400',
  36: 'text-cyan-400',
  37: 'text-slate-100',
  90: 'text-slate-400',
  91: 'text-rose-400',
  92: 'text-emerald-400',
  93: 'text-amber-400',
  94: 'text-sky-400',
  95: 'text-purple-400',
  96: 'text-cyan-400',
  97: 'text-slate-100',
};

function processLineCarriageReturns(line: string): string {
  if (!line.includes('\r') && !line.includes('\b')) {
    return line;
  }

  let result = '';
  if (line.includes('\r')) {
    const parts = line.split('\r');
    for (const part of parts) {
      if (!part) continue;
      if (part.length >= result.length) {
        result = part;
      } else {
        result = part + result.slice(part.length);
      }
    }
  } else {
    result = line;
  }

  if (result.includes('\b')) {
    const chars: string[] = [];
    for (const ch of result) {
      if (ch === '\b') {
        chars.pop();
      } else {
        chars.push(ch);
      }
    }
    result = chars.join('');
  }

  return result;
}

export function normalizeTerminalLogText(raw: string): string {
  if (!raw) return '';

  // 1. Strip OSC sequences
  let cleaned = raw.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '');

  // 2. Strip non-SGR CSI sequences (terminating with non-'m' ASCII letter or command char)
  cleaned = cleaned.replace(/\x1b\[[0-9;?]*[A-LN-Za-ln-z]/g, '');

  // 3. Strip bare \x1b not followed by valid SGR code
  cleaned = cleaned.replace(/\x1b(?!\[[0-9;]*m)/g, '');

  // 4. Strip non-printable control characters, preserving \t, \n, and \r
  cleaned = cleaned.replace(/[\x00-\x08\x0B\x0C\x0E-\x1A\x1C-\x1F]/g, '');

  // 5. Normalize \r\n to \n
  cleaned = cleaned.replace(/\r\n/g, '\n');

  // 6. Process line-internal carriage returns and backspaces
  if (cleaned.includes('\r') || cleaned.includes('\b')) {
    const lines = cleaned.split('\n');
    cleaned = lines.map(processLineCarriageReturns).join('\n');
  }

  return cleaned;
}

export function stripAnsiCodes(raw: string): string {
  const normalized = normalizeTerminalLogText(raw);
  return normalized.replace(/\x1b\[[0-9;]*m/g, '');
}

export function parseAnsiToSegments(raw: string): AnsiLogSegment[] {
  if (!raw) return [];
  const normalized = normalizeTerminalLogText(raw);
  if (!normalized) return [];

  const segments: AnsiLogSegment[] = [];
  const sgrRegex = /\x1b\[([0-9;]*)m/g;

  let currentColor: string | undefined = undefined;
  let currentBold: boolean = false;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = sgrRegex.exec(normalized)) !== null) {
    const textBefore = normalized.slice(lastIndex, match.index);
    if (textBefore.length > 0) {
      segments.push({
        text: textBefore,
        colorClass: currentColor,
        bold: currentBold,
      });
    }

    const paramStr = match[1];
    const params = paramStr.length > 0 ? paramStr.split(';').map((s) => parseInt(s, 10) || 0) : [0];

    for (let i = 0; i < params.length; i++) {
      const code = params[i];
      if (code === 0) {
        currentColor = undefined;
        currentBold = false;
      } else if (code === 1) {
        currentBold = true;
      } else if (code === 22) {
        currentBold = false;
      } else if (code === 39) {
        currentColor = undefined;
      } else if (ANSI_COLOR_MAP[code]) {
        currentColor = ANSI_COLOR_MAP[code];
      } else if (code === 38) {
        if (params[i + 1] === 5) {
          i += 2;
        } else if (params[i + 1] === 2) {
          i += 4;
        }
      }
    }

    lastIndex = sgrRegex.lastIndex;
  }

  const remainingText = normalized.slice(lastIndex);
  if (remainingText.length > 0) {
    segments.push({
      text: remainingText,
      colorClass: currentColor,
      bold: currentBold,
    });
  }

  return segments;
}
