if (typeof (globalThis as any).self === 'undefined') {
  (globalThis as any).self = globalThis;
}
import { initSafeWebglAddon } from '../frontend/src/utils/terminalWebglHelper';

describe('Terminal Performance Optimization - WebGL Helper', () => {
  it('gracefully handles WebGL initialization failures without throwing', () => {
    const mockTerm = {
      loadAddon: jest.fn(() => {
        throw new Error('WebGL not supported');
      }),
    };
    const result = initSafeWebglAddon(mockTerm as any);
    expect(result.addon).toBeNull();
    expect(typeof result.dispose).toBe('function');
  });

  it('successfully loads addon when WebGL is supported and registers onContextLoss', () => {
    let contextLossCb: (() => void) | null = null;
    const mockAddonInstance = {
      onContextLoss: jest.fn((cb) => {
        contextLossCb = cb;
        return { dispose: jest.fn() };
      }),
      dispose: jest.fn(),
    };
    const MockWebglAddon = jest.fn(() => mockAddonInstance);
    const mockTerm = {
      loadAddon: jest.fn(),
    };

    const result = initSafeWebglAddon(mockTerm as any, MockWebglAddon as any);
    expect(result.addon).toBe(mockAddonInstance);
    expect(mockTerm.loadAddon).toHaveBeenCalledWith(mockAddonInstance);

    // Simulate context loss
    if (contextLossCb) {
      (contextLossCb as () => void)();
    }
    expect(mockAddonInstance.dispose).toHaveBeenCalled();
  });
});
