import {
  isFullscreenActive,
  enterBrowserFullscreen,
  exitBrowserFullscreen,
  toggleBrowserFullscreen,
  onFullscreenChange,
} from '../frontend/src/utils/browserFullscreenHelper';

class MockDocument extends EventTarget {
  fullscreenElement: any = null;
  documentElement: any = {};
  exitFullscreen = jest.fn().mockResolvedValue(undefined);
}

if (typeof (global as any).document === 'undefined') {
  (global as any).document = new MockDocument();
}

describe('browserFullscreenHelper', () => {
  let originalFullscreenElement: any;
  let requestFullscreenMock: jest.Mock;
  let exitFullscreenMock: jest.Mock;

  beforeEach(() => {
    originalFullscreenElement = (document as any).fullscreenElement;
    requestFullscreenMock = jest.fn().mockResolvedValue(undefined);
    exitFullscreenMock = jest.fn().mockResolvedValue(undefined);

    (document.documentElement as any).requestFullscreen = requestFullscreenMock;
    (document as any).exitFullscreen = exitFullscreenMock;
    Object.defineProperty(document, 'fullscreenElement', {
      configurable: true,
      writable: true,
      value: null,
    });
  });

  afterEach(() => {
    Object.defineProperty(document, 'fullscreenElement', {
      configurable: true,
      writable: true,
      value: originalFullscreenElement,
    });
  });

  it('detects fullscreen status accurately', () => {
    expect(isFullscreenActive()).toBe(false);
    (document as any).fullscreenElement = document.documentElement;
    expect(isFullscreenActive()).toBe(true);
  });

  it('calls requestFullscreen on enter and locks orientation on mobile', async () => {
    const lockMock = jest.fn().mockResolvedValue(undefined);
    (global as any).screen = { orientation: { lock: lockMock } };

    await enterBrowserFullscreen(true);
    expect(requestFullscreenMock).toHaveBeenCalled();
    expect(lockMock).toHaveBeenCalledWith('landscape');
  });

  it('gracefully handles orientation.lock failures (e.g. iOS Safari)', async () => {
    const lockMock = jest.fn().mockRejectedValue(new Error('NotSupportedError'));
    (global as any).screen = { orientation: { lock: lockMock } };

    await expect(enterBrowserFullscreen(true)).resolves.not.toThrow();
    expect(requestFullscreenMock).toHaveBeenCalled();
  });

  it('calls keyboard.lock on desktop if available', async () => {
    const keyLockMock = jest.fn().mockResolvedValue(undefined);
    (global as any).navigator = { keyboard: { lock: keyLockMock } };

    await enterBrowserFullscreen(false);
    expect(requestFullscreenMock).toHaveBeenCalled();
    expect(keyLockMock).toHaveBeenCalledWith(['Escape']);
  });

  it('calls exitFullscreen and unlocks orientation and keyboard on exit', async () => {
    (document as any).fullscreenElement = document.documentElement;
    const unlockMock = jest.fn();
    const keyUnlockMock = jest.fn();
    (global as any).screen = { orientation: { unlock: unlockMock } };
    (global as any).navigator = { keyboard: { unlock: keyUnlockMock } };

    await exitBrowserFullscreen();
    expect(exitFullscreenMock).toHaveBeenCalled();
    expect(unlockMock).toHaveBeenCalled();
    expect(keyUnlockMock).toHaveBeenCalled();
  });

  it('subscribes and unregisters fullscreenchange events', () => {
    const cb = jest.fn();
    const cleanup = onFullscreenChange(cb);

    document.dispatchEvent(new Event('fullscreenchange'));
    expect(cb).toHaveBeenCalledWith(false);

    (document as any).fullscreenElement = document.documentElement;
    document.dispatchEvent(new Event('fullscreenchange'));
    expect(cb).toHaveBeenCalledWith(true);

    cleanup();
    cb.mockClear();
    document.dispatchEvent(new Event('fullscreenchange'));
    expect(cb).not.toHaveBeenCalled();
  });
});
