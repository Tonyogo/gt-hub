import { Terminal } from '@xterm/xterm';
import { WebglAddon } from '@xterm/addon-webgl';

export interface SafeWebglResult {
  addon: WebglAddon | null;
  dispose: () => void;
}

export function initSafeWebglAddon(
  term: Terminal,
  AddonCtor: typeof WebglAddon = WebglAddon
): SafeWebglResult {
  let addon: WebglAddon | null = null;
  try {
    addon = new AddonCtor();
    addon.onContextLoss(() => {
      console.warn('[WebTerminal] WebGL context lost, disposing and falling back to standard canvas renderer');
      try {
        addon?.dispose();
      } catch {}
      addon = null;
    });
    term.loadAddon(addon);
  } catch (err) {
    console.warn('[WebTerminal] WebGL not supported or failed to initialize, using standard renderer', err);
    try {
      addon?.dispose();
    } catch {}
    addon = null;
  }

  return {
    addon,
    dispose: () => {
      if (addon) {
        try {
          addon.dispose();
        } catch {}
        addon = null;
      }
    },
  };
}
