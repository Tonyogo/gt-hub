import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';

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

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('checking');
  const [authRequired, setAuthRequired] = useState<boolean>(true);
  const [adminKey, setAdminKey] = useState<string>(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('admin_secret_key') || '';
    }
    return '';
  });
  const [error, setError] = useState<string | null>(null);

  const checkAuth = useCallback(async () => {
    try {
      const storedKey = typeof window !== 'undefined' ? localStorage.getItem('admin_secret_key') || '' : '';
      const headers: HeadersInit = storedKey ? { 'x-admin-key': storedKey } : {};
      const res = await fetch('/api/auth/status', { headers });

      if (res.ok) {
        const data = await res.json();
        setAuthRequired(Boolean(data.authRequired));

        if (!data.authRequired || data.authenticated) {
          setAdminKey(storedKey);
          setStatus('authenticated');
        } else {
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
        if (typeof window !== 'undefined') {
          localStorage.setItem('admin_secret_key', key);
        }
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
    if (typeof window !== 'undefined') {
      localStorage.removeItem('admin_secret_key');
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
