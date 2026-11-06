export interface ParsedTerminalNotification {
  title: string;
  body: string;
}

export const DEFAULT_NOTIFY_API_URL = 'https://www.yatao.cc.cd/api/admin/notify';

export interface UnifiedNotificationPayload {
  apiUrl?: string;
  adminKey: string;
  type?: 'info' | 'warning' | 'error' | 'success';
  title: string;
  message: string;
}

/**
 * Sends a notification directly to the unified notification endpoint.
 * Non-blocking, fails gracefully on network errors or timeouts.
 */
export async function sendUnifiedNotification(payload: UnifiedNotificationPayload): Promise<boolean> {
  if (!payload || !payload.adminKey) {
    return false;
  }
  const url = payload.apiUrl || DEFAULT_NOTIFY_API_URL;
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timeoutId = controller ? setTimeout(() => controller.abort(), 5000) : null;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-admin-key': payload.adminKey,
      },
      body: JSON.stringify({
        type: payload.type || 'info',
        title: payload.title,
        message: payload.message,
      }),
      signal: controller ? controller.signal : undefined,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

/**
 * Parses iTerm2 OSC 9 notification sequence payload: \x1b]9;<message>\x07
 * Ignores ConEmu progress bar subcommands (\x1b]9;4;...).
 */
export function parseOsc9Notification(data: string): ParsedTerminalNotification | null {
  if (!data || typeof data !== 'string') return null;
  const trimmed = data.trim();
  if (!trimmed) return null;
  // Ignore ConEmu / Windows Terminal progress sequences: 9;4;state;progress
  if (/^4(?:;|$)/.test(trimmed)) {
    return null;
  }
  return {
    title: '',
    body: trimmed,
  };
}

/**
 * Parses rxvt / WezTerm / Ghostty OSC 777 notification payload: \x1b]777;notify;<title>;<body>\x07
 */
export function parseOsc777Notification(data: string): ParsedTerminalNotification | null {
  if (!data || typeof data !== 'string') return null;
  const firstSemi = data.indexOf(';');
  if (firstSemi === -1) return null;

  const subcommand = data.slice(0, firstSemi).trim().toLowerCase();
  if (subcommand !== 'notify') return null;

  const rest = data.slice(firstSemi + 1);
  const secondSemi = rest.indexOf(';');
  if (secondSemi === -1) {
    const bodyOnly = rest.trim();
    if (!bodyOnly) return null;
    return { title: '', body: bodyOnly };
  }

  const title = rest.slice(0, secondSemi).trim();
  const body = rest.slice(secondSemi + 1).trim();
  if (!body) return null;

  return { title, body };
}

/**
 * Parses Kitty OSC 99 notification payload: \x1b]99;<metadata>;<payload>\x07
 */
export function parseOsc99Notification(data: string): ParsedTerminalNotification | null {
  if (!data || typeof data !== 'string') return null;
  const semiIdx = data.indexOf(';');
  const body = (semiIdx === -1 ? data : data.slice(semiIdx + 1)).trim();
  if (!body) return null;
  return {
    title: '',
    body,
  };
}

/**
 * Coordinates OSC text notifications with standard terminal BEL (\x07) signals
 * so companion bells emitted right after an OSC 9/777 sequence are deduplicated,
 * and rapid consecutive bells are rate-limited.
 */
export class TerminalBellCoordinator {
  private lastOscTime = -Infinity;
  private lastBellTime = -Infinity;
  private readonly oscSuppressWindowMs: number;
  private readonly bellCooldownMs: number;

  constructor(oscSuppressWindowMs: number = 500, bellCooldownMs: number = 3000) {
    this.oscSuppressWindowMs = oscSuppressWindowMs;
    this.bellCooldownMs = bellCooldownMs;
  }

  public recordOscNotification(now: number = Date.now()): void {
    this.lastOscTime = now;
  }

  public shouldTriggerBell(now: number = Date.now()): boolean {
    if (now - this.lastOscTime < this.oscSuppressWindowMs) {
      return false;
    }
    if (now - this.lastBellTime < this.bellCooldownMs) {
      return false;
    }
    this.lastBellTime = now;
    return true;
  }
}
