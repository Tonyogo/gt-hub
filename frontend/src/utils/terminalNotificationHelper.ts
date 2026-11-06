export interface ParsedTerminalNotification {
  title: string;
  body: string;
}

export const TERMINAL_NOTIFICATIONS_STORAGE_KEY = 'gt_terminal_notifications_enabled';

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

export function getTerminalNotificationsEnabled(): boolean {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return true;
    const raw = window.localStorage.getItem(TERMINAL_NOTIFICATIONS_STORAGE_KEY);
    if (raw === null) return true;
    return raw !== 'false';
  } catch {
    return true;
  }
}

export function setTerminalNotificationsEnabled(enabled: boolean): void {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.setItem(TERMINAL_NOTIFICATIONS_STORAGE_KEY, enabled ? 'true' : 'false');
    }
  } catch {
    // Ignore storage errors
  }
}

export async function requestBrowserNotificationPermission(): Promise<NotificationPermission | 'unsupported'> {
  try {
    if (typeof window === 'undefined' || !('Notification' in window)) {
      return 'unsupported';
    }
    if (Notification.permission === 'granted' || Notification.permission === 'denied') {
      return Notification.permission;
    }
    return await Notification.requestPermission();
  } catch {
    return 'unsupported';
  }
}

export function playNotificationChime(): void {
  try {
    if (typeof window === 'undefined') return;
    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;

    const ctx = new AudioCtx();
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, now);
    osc.frequency.exponentialRampToValueAtTime(1174.66, now + 0.08);

    gain.gain.setValueAtTime(0.08, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.22);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start(now);
    osc.stop(now + 0.22);
    osc.onended = () => {
      ctx.close().catch(() => {});
    };
  } catch {
    // Ignore Web Audio errors when autoplay is blocked
  }
}

export function dispatchBrowserNotification(title: string, body: string, tag?: string): void {
  try {
    if (typeof window === 'undefined' || !('Notification' in window)) return;
    if (Notification.permission === 'granted') {
      const n = new Notification(title, {
        body,
        tag: tag || 'gt-terminal-notification',
      });
      n.onclick = () => {
        try {
          window.focus();
          n.close();
        } catch {
          // Ignore focus errors
        }
      };
    } else if (Notification.permission === 'default') {
      Notification.requestPermission().then((perm) => {
        if (perm === 'granted') {
          const n = new Notification(title, {
            body,
            tag: tag || 'gt-terminal-notification',
          });
          n.onclick = () => {
            try {
              window.focus();
              n.close();
            } catch {
              // Ignore
            }
          };
        }
      }).catch(() => {});
    }
  } catch {
    // Ignore Notification API errors
  }
}
