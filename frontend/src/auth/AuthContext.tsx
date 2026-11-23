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

declare const __GT_ALLOWED_PARENT_ORIGINS__: string | undefined;

export interface MinimalHistoryWindowLike {
  location?: {
    pathname?: string;
    search?: string;
    hash?: string;
    origin?: string;
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

export function parseAllowedParentOrigins(raw?: string): string[] {
  if (!raw || typeof raw !== 'string') return [];
  const entries = raw.split(',').map((s) => s.trim()).filter(Boolean);
  const result: string[] = [];
  for (const entry of entries) {
    try {
      const url = new URL(entry);
      if (url.origin && url.origin !== 'null' && !result.includes(url.origin)) {
        result.push(url.origin);
      }
    } catch {
      // Ignore invalid URL format
    }
  }
  return result;
}

export function getAllowedParentOrigins(): string[] {
  const raw =
    typeof __GT_ALLOWED_PARENT_ORIGINS__ !== 'undefined'
      ? __GT_ALLOWED_PARENT_ORIGINS__
      : typeof process !== 'undefined'
      ? process.env?.VITE_ALLOWED_PARENT_ORIGINS
      : undefined;
  return parseAllowedParentOrigins(raw);
}

const MULTI_PART_PUBLIC_SUFFIXES = [
  '.cc.cd',
  '.co.uk',
  '.com.cn',
  '.org.cn',
  '.net.cn',
  '.gov.cn',
  '.ac.uk',
  '.github.io',
];

export function getEffectiveBaseDomain(hostname: string): string {
  if (!hostname || typeof hostname !== 'string') return '';
  const host = hostname.trim().toLowerCase();

  let cleanHost = host;
  if (cleanHost.startsWith('[') && cleanHost.includes(']')) {
    cleanHost = cleanHost.slice(0, cleanHost.indexOf(']') + 1);
  } else if (cleanHost.includes(':') && !cleanHost.includes('.')) {
    // IPv6 without brackets
  } else if (cleanHost.includes(':')) {
    cleanHost = cleanHost.split(':')[0];
  }

  const isIpv4 = /^(\d{1,3}\.){3}\d{1,3}$/.test(cleanHost);
  const isIpv6 = cleanHost.startsWith('[') || cleanHost.includes(':');
  if (isIpv4 || isIpv6 || !cleanHost.includes('.')) {
    return cleanHost;
  }

  for (const suffix of MULTI_PART_PUBLIC_SUFFIXES) {
    if (cleanHost.endsWith(suffix)) {
      const prefix = cleanHost.slice(0, -suffix.length);
      if (prefix) {
        const labels = prefix.split('.');
        const lastLabel = labels[labels.length - 1];
        if (lastLabel) {
          return `${lastLabel}${suffix}`;
        }
      }
      return cleanHost;
    }
  }

  const parts = cleanHost.split('.');
  if (parts.length <= 2) {
    return cleanHost;
  }
  return parts.slice(-2).join('.');
}

export function isRelatedSiteOrigin(selfOrigin?: string, candidateOrigin?: string): boolean {
  if (!selfOrigin || !candidateOrigin) return false;
  let selfUrl: URL;
  let candidateUrl: URL;
  try {
    selfUrl = new URL(selfOrigin);
    candidateUrl = new URL(candidateOrigin);
  } catch {
    return false;
  }

  if (!selfUrl.protocol || !candidateUrl.protocol || selfUrl.protocol !== candidateUrl.protocol) {
    return false;
  }

  const selfHost = selfUrl.hostname.toLowerCase();
  const candidateHost = candidateUrl.hostname.toLowerCase();

  if (selfHost === candidateHost) {
    return true;
  }

  const selfBase = getEffectiveBaseDomain(selfHost);
  const candidateBase = getEffectiveBaseDomain(candidateHost);

  if (selfBase && candidateBase && selfBase === candidateBase) {
    return true;
  }

  return false;
}

export function matchOriginPattern(pattern: string, origin: string): boolean {
  if (!pattern || !origin) return false;
  if (pattern === origin) return true;
  if (!pattern.includes('*')) return false;

  try {
    const patternUrl = new URL(pattern.replace(/\*/g, 'wildcard-temp-token'));
    const originUrl = new URL(origin);

    if (patternUrl.protocol !== originUrl.protocol) return false;
    if (patternUrl.port !== originUrl.port) return false;

    const escapedHostPattern = patternUrl.hostname
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
      .replace(/wildcard-temp-token/g, '[a-zA-Z0-9-]+(?:\\.[a-zA-Z0-9-]+)*');
    const regex = new RegExp(`^${escapedHostPattern}$`, 'i');
    return regex.test(originUrl.hostname);
  } catch {
    const escapedPattern = pattern
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '[a-zA-Z0-9-]+(?:\\.[a-zA-Z0-9-]+)*');
    const regex = new RegExp(`^${escapedPattern}$`, 'i');
    return regex.test(origin);
  }
}

export function isTrustedAuthEvent(
  event: { origin?: string; source?: unknown },
  win?: MinimalHistoryWindowLike | Window | null,
  allowedOrigins?: string[]
): boolean {
  const w = win !== undefined ? win : typeof window !== 'undefined' ? window : null;
  if (!w || !w.parent || w.parent === w || !event || event.source !== w.parent) {
    return false;
  }

  const origin = event.origin;
  if (!origin || typeof origin !== 'string' || origin === 'null') {
    return false;
  }

  // Same-origin check
  const selfOrigin = w.location?.origin;
  if (selfOrigin && selfOrigin !== 'null' && origin === selfOrigin) {
    return true;
  }

  // Related-site origin check
  if (selfOrigin && selfOrigin !== 'null' && isRelatedSiteOrigin(selfOrigin, origin)) {
    return true;
  }

  // Allowlist check with wildcard pattern support
  const list = allowedOrigins && allowedOrigins.length > 0 ? allowedOrigins : getAllowedParentOrigins();
  for (const item of list) {
    if (matchOriginPattern(item, origin)) {
      return true;
    }
  }

  return false;
}

export function requestParentAuth(
  win?: MinimalHistoryWindowLike | Window | any,
  allowedOrigins?: string[]
): boolean {
  const w = win !== undefined ? win : typeof window !== 'undefined' ? window : null;
  try {
    if (w?.parent && w.parent !== w && typeof w.parent.postMessage === 'function') {
      const list = allowedOrigins && allowedOrigins.length > 0 ? allowedOrigins : getAllowedParentOrigins();
      const concreteOrigins = list.filter((o) => !o.includes('*'));
      const hasWildcard = list.some((o) => o.includes('*'));

      if (concreteOrigins.length > 0) {
        for (const targetOrigin of concreteOrigins) {
          w.parent.postMessage({ type: 'app-hub:auth-request' }, targetOrigin);
        }
        if (hasWildcard) {
          w.parent.postMessage({ type: 'app-hub:auth-request' }, '*');
        }
        return true;
      }
      if (hasWildcard) {
        w.parent.postMessage({ type: 'app-hub:auth-request' }, '*');
        return true;
      }
      if (w.location?.origin && w.location.origin !== 'null') {
        w.parent.postMessage({ type: 'app-hub:auth-request' }, w.location.origin);
        return true;
      }
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
  const [runtimeAllowedOrigins, setRuntimeAllowedOrigins] = useState<string[]>([]);
  const allowedOriginsRef = React.useRef<string[]>([]);

  const checkAuth = useCallback(async () => {
    try {
      consumeHashAdminKey();
      const storedKey = getStoredAdminKey();
      const headers: HeadersInit = storedKey ? { 'x-admin-key': storedKey } : {};
      const res = await fetch('/api/auth/status', { headers });

      if (res.ok) {
        const data = await res.json();
        setAuthRequired(Boolean(data.authRequired));

        if (Array.isArray(data.allowedParentOrigins)) {
          setRuntimeAllowedOrigins(data.allowedParentOrigins);
          allowedOriginsRef.current = data.allowedParentOrigins;
          if (typeof window !== 'undefined') {
            requestParentAuth(window, data.allowedParentOrigins);
          }
        }

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
      const activeOrigins =
        allowedOriginsRef.current.length > 0
          ? allowedOriginsRef.current
          : runtimeAllowedOrigins.length > 0
          ? runtimeAllowedOrigins
          : undefined;

      if (!isTrustedAuthEvent(event, window, activeOrigins)) {
        return;
      }
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
  }, [checkAuth, runtimeAllowedOrigins]);

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

