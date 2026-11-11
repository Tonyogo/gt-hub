import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import {
  getStoredAdminKey,
  setStoredAdminKey,
  clearStoredAdminKey,
  ADMIN_KEY_STORAGE_KEY,
  ADMIN_LOGGED_OUT_STORAGE_KEY,
  DEFAULT_ADMIN_KEY,
} from '../utils/apiClient';

export type AuthStatus = 'checking' | 'authenticated' | 'unauthenticated';

export interface AuthContextValue {
  status: AuthStatus;
  authRequired: boolean;
  adminKey: string;
  error: string | null;
  setError: (err: string | null) => void;
  login: (key: string) => Promise<boolean>;
  logout: () => void;
  checkAuth: () => Promise<void>;
}

export interface MinimalHistoryWindowLike {
  location?: {
    pathname?: string;
    search?: string;
    hash?: string;
  };
  history?: {
    replaceState?: (data: unknown, unused: string, url?: string | URL | null) => void;
  };
  parent?: {
    postMessage?: (message: unknown, targetOrigin: string) => void;
  } | null;
}

export interface StorageLike {
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

export function consumeHashAdminKey(
  win?: MinimalHistoryWindowLike | Window | any,
  storage?: StorageLike | Pick<Storage, 'setItem'> | null
): string | null {
  const w = win !== undefined ? win : typeof window !== 'undefined' ? window : null;
  const rawHash: string = w?.location?.hash || '';
  if (!rawHash || !rawHash.includes('admin_key=')) return null;

  const content = rawHash.startsWith('#') ? rawHash.slice(1) : rawHash;
  const qIdx = content.indexOf('?');
  const hasRoutePrefix = content.startsWith('/') || qIdx !== -1;

  const routePart = hasRoutePrefix ? (qIdx !== -1 ? content.slice(0, qIdx) : content) : '';
  const queryPart = hasRoutePrefix ? (qIdx !== -1 ? content.slice(qIdx + 1) : '') : content;

  const params = new URLSearchParams(queryPart);
  const rawKey = params.get('admin_key');
  if (!rawKey || !rawKey.trim()) return null;

  const trimmedKey = rawKey.trim();
  const s =
    storage !== undefined ? storage : typeof localStorage !== 'undefined' ? localStorage : null;
  if (s) {
    try {
      s.setItem(ADMIN_KEY_STORAGE_KEY, trimmedKey);
      if ('removeItem' in s && typeof (s as any).removeItem === 'function') {
        (s as any).removeItem(ADMIN_LOGGED_OUT_STORAGE_KEY);
      }
    } catch {
      // Ignore storage errors
    }
  }

  params.delete('admin_key');
  const remainingQuery = params.toString();
  let nextHash = '';
  if (hasRoutePrefix) {
    nextHash = remainingQuery ? `#${routePart}?${remainingQuery}` : routePart ? `#${routePart}` : '';
  } else {
    nextHash = remainingQuery ? `#${remainingQuery}` : '';
  }

  try {
    const pathname = w?.location?.pathname || '/';
    const search = w?.location?.search || '';
    w?.history?.replaceState?.(null, '', `${pathname}${search}${nextHash}`);
  } catch {
    // Ignore history replaceState errors
  }

  return trimmedKey;
}

export function parseAuthMessage(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  const payload = data as Record<string, unknown>;
  if (payload.type !== 'app-hub:auth-init') return null;
  if (typeof payload.adminKey === 'string' && payload.adminKey.trim()) {
    return payload.adminKey.trim();
  }
  return null;
}

export function requestParentAuth(win?: MinimalHistoryWindowLike | Window | any): boolean {
  const w = win !== undefined ? win : typeof window !== 'undefined' ? window : null;
  try {
    if (w?.parent && w.parent !== w && typeof w.parent.postMessage === 'function') {
      w.parent.postMessage({ type: 'app-hub:auth-request' }, '*');
      return true;
    }
  } catch {
    // Ignore cross-origin errors
  }
  return false;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('checking');
  const [authRequired, setAuthRequired] = useState<boolean>(true);
  const [adminKey, setAdminKey] = useState<string>(() => {
    const hashKey = consumeHashAdminKey();
    if (hashKey) {
      return hashKey;
    }
    return getStoredAdminKey();
  });
  const [error, setError] = useState<string | null>(null);

  const checkAuth = useCallback(async () => {
    try {
      consumeHashAdminKey();
      const storedKey = getStoredAdminKey();
      const headers: HeadersInit = storedKey ? { 'x-admin-key': storedKey } : {};
      const res = await fetch('/api/auth/status', { headers });

      if (res.ok) {
        const data = await res.json();
        setAuthRequired(Boolean(data.authRequired));

        if (!data.authRequired || data.authenticated) {
          if (storedKey) {
            setStoredAdminKey(storedKey);
          }
          setAdminKey(storedKey);
          setStatus('authenticated');
        } else {
          // If candidate failed, and storedKey !== DEFAULT_ADMIN_KEY and not explicitly logged out,
          // try fallback to DEFAULT_ADMIN_KEY ('gt-hub')
          const isExplicitlyLoggedOut =
            typeof localStorage !== 'undefined' &&
            localStorage.getItem(ADMIN_LOGGED_OUT_STORAGE_KEY) === 'true';

          if (storedKey !== DEFAULT_ADMIN_KEY && !isExplicitlyLoggedOut) {
            try {
              const fallbackRes = await fetch('/api/auth/status', {
                headers: { 'x-admin-key': DEFAULT_ADMIN_KEY },
              });
              if (fallbackRes.ok) {
                const fallbackData = await fallbackRes.json();
                if (!fallbackData.authRequired || fallbackData.authenticated) {
                  setStoredAdminKey(DEFAULT_ADMIN_KEY);
                  setAdminKey(DEFAULT_ADMIN_KEY);
                  setStatus('authenticated');
                  return;
                }
              }
            } catch {
              // Fallback failed
            }
          }
          setStatus('unauthenticated');
        }
      } else {
        setStatus('unauthenticated');
      }
    } catch {
      setStatus('unauthenticated');
    }
  }, []);

  useEffect(() => {
    checkAuth();

    const handleMessage = (event: MessageEvent) => {
      const ssoKey = parseAuthMessage(event.data);
      if (ssoKey) {
        setStoredAdminKey(ssoKey);
        setAdminKey(ssoKey);
        void checkAuth();
      }
    };

    if (typeof window !== 'undefined') {
      window.addEventListener('message', handleMessage);
      requestParentAuth();
    }

    return () => {
      if (typeof window !== 'undefined') {
        window.removeEventListener('message', handleMessage);
      }
    };
  }, [checkAuth]);

  const login = useCallback(async (key: string): Promise<boolean> => {
    setError(null);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key }),
      });

      if (res.ok) {
        setStoredAdminKey(key);
        setAdminKey(key);
        setStatus('authenticated');
        return true;
      } else {
        const data = await res.json().catch(() => ({}));
        setError(data.error || 'Authentication failed: Invalid secret key');
        return false;
      }
    } catch {
      setError('Network error: Unable to connect to server');
      return false;
    }
  }, []);

  const logout = useCallback(() => {
    clearStoredAdminKey(true);
    if (typeof window !== 'undefined') {
      sessionStorage.removeItem('cached_terminal_hosts');
    }
    setAdminKey('');
    setError(null);
    setStatus('unauthenticated');
  }, []);

  return (
    <AuthContext.Provider
      value={{
        status,
        authRequired,
        adminKey,
        error,
        setError,
        login,
        logout,
        checkAuth,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}

