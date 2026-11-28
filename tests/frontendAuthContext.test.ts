import * as fs from 'fs';
import * as path from 'path';
import {
  consumeHashAdminKey,
  parseAuthMessage,
  requestParentAuth,
  parseAllowedParentOrigins,
  isTrustedAuthEvent,
  getEffectiveBaseDomain,
  isRelatedSiteOrigin,
  matchOriginPattern,
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

  it('tracks and exposes isSsoAuthenticated across hash, postMessage SSO, login, and logout', () => {
    expect(content).toContain('isSsoAuthenticated: boolean');
    expect(content).toMatch(/setIsSsoAuthenticated\(true\)/);
    expect(content).toMatch(/setIsSsoAuthenticated\(false\)/);
    expect(content).toContain('isSsoAuthenticated,');
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

  it('requestParentAuth targets same-origin when window.location.origin is present', () => {
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
      location: {
        origin: 'https://hub.example.com',
      },
    };

    const requested = requestParentAuth(mockWin);
    expect(requested).toBe(true);
    expect(postedMessage).toEqual({ type: 'app-hub:auth-request' });
    expect(targetOrigin).toBe('https://hub.example.com');
  });

  it('parseAllowedParentOrigins parses and normalizes origin URLs from string', () => {
    expect(
      parseAllowedParentOrigins('https://a.example.com, https://b.example.com/path , invalid')
    ).toEqual(['https://a.example.com', 'https://b.example.com']);
    expect(parseAllowedParentOrigins('')).toEqual([]);
    expect(parseAllowedParentOrigins(undefined)).toEqual([]);
  });

  it('isTrustedAuthEvent validates event.source against win.parent and checks origin allowlist', () => {
    const mockParent = {};
    const mockOtherWindow = {};
    const mockWin: MinimalHistoryWindowLike = {
      parent: mockParent,
      location: {
        origin: 'https://hub.example.com',
      },
    };

    // Same-origin matching location.origin
    expect(
      isTrustedAuthEvent(
        { source: mockParent, origin: 'https://hub.example.com' },
        mockWin
      )
    ).toBe(true);

    // Cross-origin allowed explicitly
    expect(
      isTrustedAuthEvent(
        { source: mockParent, origin: 'https://allowed.example.com' },
        mockWin,
        ['https://allowed.example.com']
      )
    ).toBe(true);

    // Cross-origin from unrelated domain not allowed
    expect(
      isTrustedAuthEvent(
        { source: mockParent, origin: 'https://evil.com' },
        mockWin
      )
    ).toBe(false);

    // Wrong source window
    expect(
      isTrustedAuthEvent(
        { source: mockOtherWindow, origin: 'https://hub.example.com' },
        mockWin
      )
    ).toBe(false);

    // Missing or invalid origin ('null', empty)
    expect(
      isTrustedAuthEvent(
        { source: mockParent, origin: 'null' },
        mockWin
      )
    ).toBe(false);
    expect(
      isTrustedAuthEvent(
        { source: mockParent, origin: '' },
        mockWin
      )
    ).toBe(false);
    expect(
      isTrustedAuthEvent(
        { source: mockParent },
        mockWin
      )
    ).toBe(false);

    // When win has no parent or win.parent is self
    const topWin: MinimalHistoryWindowLike = {};
    topWin.parent = topWin as any;
    expect(
      isTrustedAuthEvent(
        { source: topWin, origin: 'https://hub.example.com' },
        topWin
      )
    ).toBe(false);
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

describe('Cross-Subdomain Trust & Effective Base Domain Helpers', () => {
  describe('getEffectiveBaseDomain', () => {
    it('normalizes lowercase hostname', () => {
      expect(getEffectiveBaseDomain('WWW.EXAMPLE.COM')).toBe('example.com');
      expect(getEffectiveBaseDomain('  GT.Yatao.CC.CD  ')).toBe('yatao.cc.cd');
    });

    it('handles common multi-part public suffixes correctly', () => {
      expect(getEffectiveBaseDomain('www.yatao.cc.cd')).toBe('yatao.cc.cd');
      expect(getEffectiveBaseDomain('gt.yatao.cc.cd')).toBe('yatao.cc.cd');
      expect(getEffectiveBaseDomain('portal.co.uk')).toBe('portal.co.uk');
      expect(getEffectiveBaseDomain('sub.portal.co.uk')).toBe('portal.co.uk');
      expect(getEffectiveBaseDomain('app.com.cn')).toBe('app.com.cn');
      expect(getEffectiveBaseDomain('sub.org.cn')).toBe('sub.org.cn');
      expect(getEffectiveBaseDomain('cluster.net.cn')).toBe('cluster.net.cn');
      expect(getEffectiveBaseDomain('dept.gov.cn')).toBe('dept.gov.cn');
      expect(getEffectiveBaseDomain('cs.cam.ac.uk')).toBe('cam.ac.uk');
      expect(getEffectiveBaseDomain('myuser.github.io')).toBe('myuser.github.io');
      expect(getEffectiveBaseDomain('project.myuser.github.io')).toBe('myuser.github.io');
    });

    it('handles standard domains with single TLD', () => {
      expect(getEffectiveBaseDomain('app.example.com')).toBe('example.com');
      expect(getEffectiveBaseDomain('sub.app.example.com')).toBe('example.com');
      expect(getEffectiveBaseDomain('example.com')).toBe('example.com');
    });

    it('handles single labels, IPv4, and IPv6 addresses without failing', () => {
      expect(getEffectiveBaseDomain('localhost')).toBe('localhost');
      expect(getEffectiveBaseDomain('127.0.0.1')).toBe('127.0.0.1');
      expect(getEffectiveBaseDomain('192.168.1.10')).toBe('192.168.1.10');
      expect(getEffectiveBaseDomain('[::1]')).toBe('[::1]');
      expect(getEffectiveBaseDomain('::1')).toBe('::1');
    });
  });

  describe('isRelatedSiteOrigin', () => {
    it('returns false for missing, invalid URL, or protocol mismatch', () => {
      expect(isRelatedSiteOrigin()).toBe(false);
      expect(isRelatedSiteOrigin('https://example.com', undefined)).toBe(false);
      expect(isRelatedSiteOrigin(undefined, 'https://example.com')).toBe(false);
      expect(isRelatedSiteOrigin('invalid-url', 'https://example.com')).toBe(false);
      expect(isRelatedSiteOrigin('https://example.com', 'invalid-url')).toBe(false);
      expect(isRelatedSiteOrigin('http://example.com', 'https://example.com')).toBe(false);
      expect(isRelatedSiteOrigin('https://yatao.cc.cd', 'http://yatao.cc.cd')).toBe(false);
    });

    it('returns true when hostnames match even with different ports', () => {
      expect(isRelatedSiteOrigin('http://localhost:3000', 'http://localhost:8000')).toBe(true);
      expect(isRelatedSiteOrigin('https://hub.example.com:443', 'https://hub.example.com:8443')).toBe(true);
      expect(isRelatedSiteOrigin('http://127.0.0.1:8000', 'http://127.0.0.1:9000')).toBe(true);
    });

    it('returns true when base domains match across different subdomains', () => {
      expect(isRelatedSiteOrigin('https://gt.yatao.cc.cd', 'https://www.yatao.cc.cd')).toBe(true);
      expect(isRelatedSiteOrigin('https://sub.portal.co.uk', 'https://auth.portal.co.uk')).toBe(true);
      expect(isRelatedSiteOrigin('https://app.example.com', 'https://api.example.com')).toBe(true);
    });

    it('returns false when base domains do not match', () => {
      expect(isRelatedSiteOrigin('https://gt.yatao.cc.cd', 'https://evil.com')).toBe(false);
      expect(isRelatedSiteOrigin('https://gt.yatao.cc.cd', 'https://other.cc.cd')).toBe(false);
      expect(isRelatedSiteOrigin('https://app.example.com', 'https://app.example.org')).toBe(false);
    });
  });

  describe('matchOriginPattern & wildcard matching', () => {
    it('matches exact origins', () => {
      expect(matchOriginPattern('https://example.com', 'https://example.com')).toBe(true);
      expect(matchOriginPattern('https://example.com', 'https://other.com')).toBe(false);
    });

    it('matches wildcard subdomains with same protocol and domain suffix', () => {
      expect(matchOriginPattern('https://*.yatao.cc.cd', 'https://www.yatao.cc.cd')).toBe(true);
      expect(matchOriginPattern('https://*.yatao.cc.cd', 'https://gt.yatao.cc.cd')).toBe(true);
      expect(matchOriginPattern('https://*.yatao.cc.cd', 'https://sub.dev.yatao.cc.cd')).toBe(true);
    });

    it('rejects protocol or domain mismatch with wildcards', () => {
      expect(matchOriginPattern('https://*.yatao.cc.cd', 'http://www.yatao.cc.cd')).toBe(false);
      expect(matchOriginPattern('https://*.yatao.cc.cd', 'https://evil-yatao.cc.cd')).toBe(false);
      expect(matchOriginPattern('https://*.yatao.cc.cd', 'https://evil.com')).toBe(false);
    });
  });

  describe('isTrustedAuthEvent cross-subdomain trust', () => {
    it('trusts same-site cross-subdomain parent window out-of-the-box (e.g. www.yatao.cc.cd -> gt.yatao.cc.cd)', () => {
      const mockParent = {};
      const mockWin: MinimalHistoryWindowLike = {
        parent: mockParent,
        location: {
          origin: 'https://gt.yatao.cc.cd',
        },
      };

      // Cross-subdomain on same multi-part base domain
      expect(
        isTrustedAuthEvent(
          { source: mockParent, origin: 'https://www.yatao.cc.cd' },
          mockWin
        )
      ).toBe(true);

      // Third-party unrelated domain remains untrusted
      expect(
        isTrustedAuthEvent(
          { source: mockParent, origin: 'https://evil.cc.cd' },
          mockWin
        )
      ).toBe(false);
      expect(
        isTrustedAuthEvent(
          { source: mockParent, origin: 'https://attacker.com' },
          mockWin
        )
      ).toBe(false);
    });

    it('trusts wildcard patterns provided via allowedOrigins', () => {
      const mockParent = {};
      const mockWin: MinimalHistoryWindowLike = {
        parent: mockParent,
        location: {
          origin: 'https://standalone-hub.net',
        },
      };

      expect(
        isTrustedAuthEvent(
          { source: mockParent, origin: 'https://app.partner.com' },
          mockWin,
          ['https://*.partner.com']
        )
      ).toBe(true);

      expect(
        isTrustedAuthEvent(
          { source: mockParent, origin: 'https://evil.com' },
          mockWin,
          ['https://*.partner.com']
        )
      ).toBe(false);
    });
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

