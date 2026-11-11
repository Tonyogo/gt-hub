import * as fs from 'fs';
import * as path from 'path';
import {
  consumeHashAdminKey,
  parseAuthMessage,
  requestParentAuth,
  MinimalHistoryWindowLike,
} from '../frontend/src/auth/AuthContext';
import {
  getStoredAdminKey,
  setStoredAdminKey,
  clearStoredAdminKey,
  ADMIN_KEY_STORAGE_KEY,
  ADMIN_LOGGED_OUT_STORAGE_KEY,
  DEFAULT_ADMIN_KEY,
} from '../frontend/src/utils/apiClient';

describe('Frontend AuthContext Architecture', () => {
  const authContextPath = path.resolve(__dirname, '../frontend/src/auth/AuthContext.tsx');

  let content: string;
  beforeAll(() => {
    content = fs.readFileSync(authContextPath, 'utf-8');
  });

  it('exports AuthProvider and useAuth hook', () => {
    expect(content).toContain('export function AuthProvider');
    expect(content).toContain('export function useAuth');
  });

  it('manages checking, authenticated, and unauthenticated status', () => {
    expect(content).toContain("'checking'");
    expect(content).toContain("'authenticated'");
    expect(content).toContain("'unauthenticated'");
  });

  it('probes /api/auth/status on initialization', () => {
    expect(content).toContain('/api/auth/status');
    expect(content).toContain('getStoredAdminKey()');
  });

  it('clears session and local storage on logout', () => {
    expect(content).toContain('clearStoredAdminKey(true)');
    expect(content).toContain("sessionStorage.removeItem('cached_terminal_hosts')");
  });

  it('wires consumeHashAdminKey and app-hub postMessage listener in AuthProvider', () => {
    expect(content).toContain('consumeHashAdminKey()');
    expect(content).toContain('parseAuthMessage(event.data)');
    expect(content).toContain('requestParentAuth()');
  });
});

describe('SSO Helpers in AuthContext', () => {
  it('consumeHashAdminKey extracts and scrubs admin_key from simple hash and persists to adminKey', () => {
    let replacedUrl = '';
    const mockWin: MinimalHistoryWindowLike = {
      location: {
        pathname: '/',
        search: '?theme=dark',
        hash: '#admin_key=gt-secret',
      },
      history: {
        replaceState: (_data: unknown, _unused: string, url?: string | URL | null) => {
          replacedUrl = String(url);
        },
      },
    };

    const storageMap = new Map<string, string>();
    const mockStorage = {
      setItem: (k: string, v: string) => storageMap.set(k, v),
      removeItem: (k: string) => storageMap.delete(k),
    };

    const key = consumeHashAdminKey(mockWin, mockStorage);
    expect(key).toBe('gt-secret');
    expect(storageMap.get('adminKey')).toBe('gt-secret');
    expect(replacedUrl).toBe('/?theme=dark');
  });

  it('consumeHashAdminKey preserves hash route path and remaining query params', () => {
    let replacedUrl = '';
    const mockWin: MinimalHistoryWindowLike = {
      location: {
        pathname: '/',
        search: '',
        hash: '#/setup?host=1&admin_key=gt-secret&lang=zh',
      },
      history: {
        replaceState: (_data: unknown, _unused: string, url?: string | URL | null) => {
          replacedUrl = String(url);
        },
      },
    };

    const key = consumeHashAdminKey(mockWin, null);
    expect(key).toBe('gt-secret');
    expect(replacedUrl).toBe('/#/setup?host=1&lang=zh');
  });

  it('consumeHashAdminKey returns null and does not replaceState when admin_key is missing or empty', () => {
    const replaceSpy = jest.fn();
    const mockWin: MinimalHistoryWindowLike = {
      location: {
        pathname: '/',
        search: '',
        hash: '#/setup?host=1',
      },
      history: {
        replaceState: replaceSpy,
      },
    };

    expect(consumeHashAdminKey(mockWin, null)).toBeNull();
    expect(replaceSpy).not.toHaveBeenCalled();

    mockWin.location!.hash = '#admin_key=   ';
    expect(consumeHashAdminKey(mockWin, null)).toBeNull();
    expect(replaceSpy).not.toHaveBeenCalled();
  });

  it('consumeHashAdminKey safely handles storage and history exceptions', () => {
    const throwingStorage = {
      setItem: () => {
        throw new Error('QuotaExceeded');
      },
    };
    const throwingWin: MinimalHistoryWindowLike = {
      location: { pathname: '/', search: '', hash: '#admin_key=secret' },
      history: {
        replaceState: () => {
          throw new Error('SecurityError');
        },
      },
    };

    expect(() => consumeHashAdminKey(throwingWin, throwingStorage)).not.toThrow();
  });

  it('parseAuthMessage parses app-hub:auth-init events and ignores invalid types', () => {
    expect(parseAuthMessage({ type: 'app-hub:auth-init', adminKey: 'gt-key' })).toBe('gt-key');
    expect(parseAuthMessage({ type: 'app-hub:auth-init', adminKey: '  padded-gt-key  ' })).toBe(
      'padded-gt-key'
    );
    expect(parseAuthMessage({ type: 'app-hub:auth-init', adminKey: '' })).toBeNull();
    expect(parseAuthMessage({ type: 'app-hub:auth-init' })).toBeNull();
    expect(parseAuthMessage({ type: 'other-event', adminKey: 'gt-key' })).toBeNull();
    expect(parseAuthMessage(null)).toBeNull();
    expect(parseAuthMessage('app-hub:auth-init')).toBeNull();
  });

  it('requestParentAuth sends postMessage to parent when embedded in iframe', () => {
    let postedMessage: unknown = null;
    let targetOrigin = '';

    const mockParent = {
      postMessage: (msg: unknown, origin: string) => {
        postedMessage = msg;
        targetOrigin = origin;
      },
    };

    const mockWin: MinimalHistoryWindowLike = {
      parent: mockParent,
    };

    const requested = requestParentAuth(mockWin);
    expect(requested).toBe(true);
    expect(postedMessage).toEqual({ type: 'app-hub:auth-request' });
    expect(targetOrigin).toBe('*');
  });

  it('requestParentAuth returns false when top window or parent postMessage unavailable', () => {
    const selfWin: MinimalHistoryWindowLike = {};
    selfWin.parent = selfWin as any;
    expect(requestParentAuth(selfWin)).toBe(false);

    expect(requestParentAuth(null)).toBe(false);

    const throwingWin = {
      get parent(): any {
        throw new Error('Blocked a frame with origin from accessing a cross-origin frame');
      },
    };
    expect(requestParentAuth(throwingWin)).toBe(false);
  });
});

class MockLocalStorage {
  private store = new Map<string, string>();
  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  clear(): void {
    this.store.clear();
  }
}

describe('Frontend apiClient storage helpers', () => {
  let mockStorage: MockLocalStorage;

  beforeEach(() => {
    mockStorage = new MockLocalStorage();
    (global as any).window = global;
    (global as any).localStorage = mockStorage;
  });

  afterEach(() => {
    delete (global as any).window;
    delete (global as any).localStorage;
  });

  it('exports standardized storage keys and DEFAULT_ADMIN_KEY = "gt-hub"', () => {
    expect(ADMIN_KEY_STORAGE_KEY).toBe('adminKey');
    expect(ADMIN_LOGGED_OUT_STORAGE_KEY).toBe('admin_logged_out');
    expect(DEFAULT_ADMIN_KEY).toBe('gt-hub');
  });

  it('getStoredAdminKey returns DEFAULT_ADMIN_KEY by default unless explicitly logged out', () => {
    expect(getStoredAdminKey()).toBe('gt-hub');

    localStorage.setItem(ADMIN_LOGGED_OUT_STORAGE_KEY, 'true');
    expect(getStoredAdminKey()).toBe('');
  });

  it('getStoredAdminKey reads adminKey with backward compatibility for admin_secret_key and gt_admin_key', () => {
    localStorage.setItem('gt_admin_key', 'legacy-gt');
    expect(getStoredAdminKey()).toBe('legacy-gt');

    localStorage.setItem('admin_secret_key', 'legacy-admin-secret');
    expect(getStoredAdminKey()).toBe('legacy-admin-secret');

    localStorage.setItem('adminKey', 'unified-key');
    expect(getStoredAdminKey()).toBe('unified-key');
  });

  it('setStoredAdminKey persists to adminKey and cleans up legacy and logged out keys', () => {
    localStorage.setItem('admin_secret_key', 'old1');
    localStorage.setItem('gt_admin_key', 'old2');
    localStorage.setItem(ADMIN_LOGGED_OUT_STORAGE_KEY, 'true');

    setStoredAdminKey('new-val');
    expect(localStorage.getItem('adminKey')).toBe('new-val');
    expect(localStorage.getItem('admin_secret_key')).toBeNull();
    expect(localStorage.getItem('gt_admin_key')).toBeNull();
    expect(localStorage.getItem(ADMIN_LOGGED_OUT_STORAGE_KEY)).toBeNull();
  });

  it('clearStoredAdminKey removes keys and conditionally marks logged out', () => {
    setStoredAdminKey('key1');
    clearStoredAdminKey(false);
    expect(localStorage.getItem('adminKey')).toBeNull();
    expect(localStorage.getItem(ADMIN_LOGGED_OUT_STORAGE_KEY)).toBeNull();

    setStoredAdminKey('key2');
    clearStoredAdminKey(true);
    expect(localStorage.getItem('adminKey')).toBeNull();
    expect(localStorage.getItem(ADMIN_LOGGED_OUT_STORAGE_KEY)).toBe('true');
  });
});

