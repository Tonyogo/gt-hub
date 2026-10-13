/**
 * Browser Fullscreen & Mobile Landscape Orientation Helper
 */

export function isFullscreenActive(): boolean {
  if (typeof document === 'undefined') return false;
  return Boolean(
    document.fullscreenElement ||
    (document as any).webkitFullscreenElement ||
    (document as any).mozFullScreenElement ||
    (document as any).msFullscreenElement
  );
}

export async function enterBrowserFullscreen(isMobile?: boolean): Promise<void> {
  if (typeof document === 'undefined') return;

  const docEl = document.documentElement as any;
  if (!isFullscreenActive()) {
    if (docEl.requestFullscreen) {
      await docEl.requestFullscreen();
    } else if (docEl.webkitRequestFullscreen) {
      await docEl.webkitRequestFullscreen();
    } else if (docEl.mozRequestFullScreen) {
      await docEl.mozRequestFullScreen();
    } else if (docEl.msRequestFullscreen) {
      await docEl.msRequestFullscreen();
    }
  }

  // Mobile: Lock to landscape orientation like video playback
  if (isMobile) {
    try {
      if (typeof screen !== 'undefined' && screen.orientation && typeof (screen.orientation as any).lock === 'function') {
        await (screen.orientation as any).lock('landscape').catch(() => {});
      }
    } catch {
      // Ignore NotSupportedError on platforms like iOS Safari
    }
  } else {
    // Desktop: Lock Escape key if supported to avoid conflicting with Vim/Nano
    try {
      if (typeof navigator !== 'undefined' && (navigator as any).keyboard && typeof (navigator as any).keyboard.lock === 'function') {
        await (navigator as any).keyboard.lock(['Escape']).catch(() => {});
      }
    } catch {
      // Ignore unsupported browsers
    }
  }
}

export async function exitBrowserFullscreen(): Promise<void> {
  if (typeof document === 'undefined') return;

  if (isFullscreenActive()) {
    const doc = document as any;
    if (doc.exitFullscreen) {
      await doc.exitFullscreen();
    } else if (doc.webkitExitFullscreen) {
      await doc.webkitExitFullscreen();
    } else if (doc.mozCancelFullScreen) {
      await doc.mozCancelFullScreen();
    } else if (doc.msExitFullscreen) {
      await doc.msExitFullscreen();
    }
  }

  // Unlock orientation
  try {
    if (typeof screen !== 'undefined' && screen.orientation && typeof (screen.orientation as any).unlock === 'function') {
      (screen.orientation as any).unlock();
    }
  } catch {}

  // Unlock keyboard
  try {
    if (typeof navigator !== 'undefined' && (navigator as any).keyboard && typeof (navigator as any).keyboard.unlock === 'function') {
      (navigator as any).keyboard.unlock();
    }
  } catch {}
}

export async function toggleBrowserFullscreen(isMobile?: boolean): Promise<boolean> {
  if (isFullscreenActive()) {
    await exitBrowserFullscreen();
    return false;
  } else {
    await enterBrowserFullscreen(isMobile);
    return true;
  }
}

export function onFullscreenChange(callback: (isFullscreen: boolean) => void): () => void {
  if (typeof document === 'undefined') return () => {};

  const handler = () => {
    callback(isFullscreenActive());
  };

  document.addEventListener('fullscreenchange', handler);
  document.addEventListener('webkitfullscreenchange', handler);
  document.addEventListener('mozfullscreenchange', handler);
  document.addEventListener('MSFullscreenChange', handler);

  return () => {
    document.removeEventListener('fullscreenchange', handler);
    document.removeEventListener('webkitfullscreenchange', handler);
    document.removeEventListener('mozfullscreenchange', handler);
    document.removeEventListener('MSFullscreenChange', handler);
  };
}
