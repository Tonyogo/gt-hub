import * as fs from 'fs';
import * as path from 'path';
import {
  consumeHashAdminKey,
  parseAuthMessage,
  requestParentAuth,
  MinimalHistoryWindowLike,
} from '../frontend/src/auth/AuthContext';

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
    expect(content).toContain('admin_secret_key');
  });

  it('clears session and local storage on logout', () => {
    expect(content).toContain("localStorage.removeItem('admin_secret_key')");
    expect(content).toContain("sessionStorage.removeItem('cached_terminal_hosts')");
  });

  it('wires consumeHashAdminKey and app-hub postMessage listener in AuthProvider', () => {
    expect(content).toContain('consumeHashAdminKey()');
    expect(content).toContain('parseAuthMessage(event.data)');
    expect(content).toContain('requestParentAuth()');
  });
});

describe('SSO Helpers in AuthContext', () => {
  it('consumeHashAdminKey extracts and scrubs admin_key from simple hash and persists to admin_secret_key', () => {
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
    };

    const key = consumeHashAdminKey(mockWin, mockStorage);
    expect(key).toBe('gt-secret');
    expect(storageMap.get('admin_secret_key')).toBe('gt-secret');
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

