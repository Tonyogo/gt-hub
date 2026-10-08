# Auth Guard and Mandatory Login Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent unauthenticated access to the terminal and file manager by enforcing an Auth Guard that renders a full-screen login page when unauthenticated, and grants access only upon successful secret key verification.

**Architecture:** Add lightweight public backend endpoints (`/api/auth/status` and `/api/auth/login`). Introduce an `AuthContext` on the frontend that probes auth status on startup and gates the application root in `App.tsx`, completely blocking `UnifiedTerminalView` from mounting until credentials are valid, with logout and 401 auto-redirection support.

**Tech Stack:** Express, TypeScript, React 18, Tailwind CSS, Lucide React, Jest, Supertest.

**Spec:** `docs/superpowers/specs/2026-10-08-auth-guard-and-login-page-design.md`

## Global Constraints

- **Zero Unauthorized Mounting**: `UnifiedTerminalView`, xterm.js, and WebSocket clients must NEVER mount when the user is unauthenticated, eliminating silent 401 background failures.
- **Auto-Detection (Zero Password Mode)**: When `config.adminSecretKey` is empty or unset, `/api/auth/status` reports `authRequired: false`, allowing seamless direct entry without prompting for login.
- **Session Cleanup on Logout / 401**: Logging out or receiving a 401 response from any terminal API immediately clears `admin_secret_key` in `localStorage` and `cached_terminal_hosts` in `sessionStorage` and redirects to the login view.
- **Full Viewport Consistency**: Both the login page and terminal workspace must occupy `100dvh` × `100vw` without scroll leakage or outer container nesting.
- **HTTP Status Semantics**: `/api/auth/status` always returns HTTP 200 with `{ authRequired, authenticated }` to avoid console error pollution during initial probe.

## Review Focus

1. **Unconfigured Server Key Auto-Bypass**: If `ADMIN_SECRET_KEY` is empty, opening the app must immediately enter the terminal workspace without displaying the login page.
2. **Invalid Secret Key Submission**: Submitting an incorrect key on the login page must stay on the login page, display a clear error message, and return HTTP 401 from `/api/auth/login`.
3. **Correct Secret Key Transition**: Submitting the valid key must store it in `localStorage`, transition state to `authenticated`, and mount `UnifiedTerminalView` without page reload.
4. **401 Response Auto-Logout**: If any protected API responds with HTTP 401, the frontend must detect it, clear credentials, and revert to `LoginView`.
5. **Theme & Language Persistence on Login Page**: The login page must allow switching theme (light/dark) and language (zh/en) before logging in, persisting the preferences across logins.

---

### Task 1: Backend Auth Status and Login Endpoints

**Files:**
- Create: `src/auth/routes/authRoutes.ts`
- Modify: `src/app.ts:38-42`
- Test: `tests/authRoutes.test.ts`

**Interfaces:**
- Consumes:
  - `config.adminSecretKey` from `../../config/default`
- Produces:
  - `GET /api/auth/status`: returns `{ authRequired: boolean, authenticated: boolean }`
  - `POST /api/auth/login`: accepts `{ key: string }`, returns 200 `{ success: true }` or 401 `{ error: string }`

- [ ] **Step 1: Write the failing test for backend auth endpoints**

Create `tests/authRoutes.test.ts`:
```ts
import request from 'supertest';
import express from 'express';
import authRoutes from '../src/auth/routes/authRoutes';
import config from '../config/default';

describe('Auth Routes (/api/auth)', () => {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRoutes);

  const originalKey = config.adminSecretKey;

  afterEach(() => {
    config.adminSecretKey = originalKey;
  });

  describe('GET /api/auth/status', () => {
    it('returns authRequired: false and authenticated: true when no adminSecretKey is set', async () => {
      config.adminSecretKey = '';
      const res = await request(app).get('/api/auth/status');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ authRequired: false, authenticated: true });
    });

    it('returns authRequired: true and authenticated: false when key is required but none provided', async () => {
      config.adminSecretKey = 'correct-secret-key';
      const res = await request(app).get('/api/auth/status');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ authRequired: true, authenticated: false });
    });

    it('returns authenticated: true when valid x-admin-key header is provided', async () => {
      config.adminSecretKey = 'correct-secret-key';
      const res = await request(app)
        .get('/api/auth/status')
        .set('x-admin-key', 'correct-secret-key');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ authRequired: true, authenticated: true });
    });

    it('returns authenticated: false when invalid x-admin-key header is provided', async () => {
      config.adminSecretKey = 'correct-secret-key';
      const res = await request(app)
        .get('/api/auth/status')
        .set('x-admin-key', 'wrong-key');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ authRequired: true, authenticated: false });
    });
  });

  describe('POST /api/auth/login', () => {
    it('returns 200 success when server requires no key', async () => {
      config.adminSecretKey = '';
      const res = await request(app).post('/api/auth/login').send({ key: 'any-key' });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true });
    });

    it('returns 200 success when matching key is provided', async () => {
      config.adminSecretKey = 'my-secret-token';
      const res = await request(app).post('/api/auth/login').send({ key: 'my-secret-token' });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true });
    });

    it('returns 401 when wrong key is provided', async () => {
      config.adminSecretKey = 'my-secret-token';
      const res = await request(app).post('/api/auth/login').send({ key: 'bad-token' });
      expect(res.status).toBe(401);
      expect(res.body).toHaveProperty('error');
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/authRoutes.test.ts`
Expected: FAIL (Cannot find module `../src/auth/routes/authRoutes`).

- [ ] **Step 3: Implement authRoutes and mount in src/app.ts**

Create `src/auth/routes/authRoutes.ts`:
```ts
import { Router, Request, Response } from 'express';
import config from '../../../config/default';

const router = Router();

router.get('/status', (req: Request, res: Response) => {
  const secretKey = config.adminSecretKey;
  if (!secretKey) {
    res.status(200).json({ authRequired: false, authenticated: true });
    return;
  }

  const providedKey = req.headers['x-admin-key'] || req.query['x-admin-key'] || req.query.key;
  const authenticated = providedKey === secretKey;

  res.status(200).json({
    authRequired: true,
    authenticated,
  });
});

router.post('/login', (req: Request, res: Response) => {
  const secretKey = config.adminSecretKey;
  if (!secretKey) {
    res.status(200).json({ success: true });
    return;
  }

  const { key } = req.body || {};
  if (key === secretKey) {
    res.status(200).json({ success: true });
  } else {
    res.status(401).json({ error: 'Unauthorized: Invalid secret key' });
  }
});

export default router;
```

Update `src/app.ts` to register `authRoutes`:
```ts
import authRoutes from './auth/routes/authRoutes';

// Add route registration around line 42:
app.use('/api/auth', authRoutes);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/authRoutes.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/auth/routes/authRoutes.ts src/app.ts tests/authRoutes.test.ts
git commit -m "feat(auth): add /api/auth/status and /api/auth/login endpoints"
```

---

### Task 2: Frontend Auth Context and Provider

**Files:**
- Create: `frontend/src/auth/AuthContext.tsx`
- Test: `tests/frontendAuthContext.test.ts`

**Interfaces:**
- Consumes:
  - `GET /api/auth/status`
  - `POST /api/auth/login`
  - `localStorage` item `admin_secret_key`
- Produces:
  - `useAuth()` hook with `{ status, authRequired, adminKey, login, logout, error, setError }`
  - `AuthProvider` React component

- [ ] **Step 1: Write the failing test for frontend AuthContext**

Create `tests/frontendAuthContext.test.ts`:
```ts
import * as fs from 'fs';
import * as path from 'path';

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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/frontendAuthContext.test.ts`
Expected: FAIL (`AuthContext.tsx` does not exist yet).

- [ ] **Step 3: Implement AuthContext.tsx**

Create `frontend/src/auth/AuthContext.tsx`:
```tsx
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/frontendAuthContext.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/auth/AuthContext.tsx tests/frontendAuthContext.test.ts
git commit -m "feat(auth): implement frontend AuthContext with status probe and logout"
```

---

### Task 3: Fullscreen Login Page (`LoginView.tsx`)

**Files:**
- Create: `frontend/src/components/LoginView.tsx`
- Test: `tests/frontendLoginView.test.ts`

**Interfaces:**
- Consumes:
  - `useAuth()` for `login`, `error`, `setError`
  - `useTranslation()` for i18n
  - `useTheme()` for theme toggling
- Produces:
  - `LoginView` React component rendering a full-screen, centered login card with theme/language controls.

- [ ] **Step 1: Write the failing test for LoginView**

Create `tests/frontendLoginView.test.ts`:
```ts
import * as fs from 'fs';
import * as path from 'path';

describe('LoginView Component Architecture', () => {
  const loginViewPath = path.resolve(__dirname, '../frontend/src/components/LoginView.tsx');

  let content: string;
  beforeAll(() => {
    content = fs.readFileSync(loginViewPath, 'utf-8');
  });

  it('renders a full screen flex container', () => {
    expect(content).toContain('h-[100dvh]');
    expect(content).toContain('w-screen');
  });

  it('includes secret key input with autoFocus and password type', () => {
    expect(content).toContain('autoFocus');
    expect(content).toContain('type=');
    expect(content).toContain('password');
  });

  it('integrates language and theme toggles in the login header', () => {
    expect(content).toContain('useTheme');
    expect(content).toContain('useTranslation');
    expect(content).toContain('Languages');
    expect(content).toMatch(/Sun|Moon/);
  });

  it('submits form via useAuth().login', () => {
    expect(content).toContain('useAuth()');
    expect(content).toContain('login(');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/frontendLoginView.test.ts`
Expected: FAIL (`LoginView.tsx` does not exist yet).

- [ ] **Step 3: Implement LoginView.tsx**

Create `frontend/src/components/LoginView.tsx`:
```tsx
import React, { useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { useTranslation } from '../i18n/LanguageContext';
import { useTheme } from '../theme/ThemeContext';
import { KeyRound, Lock, Eye, EyeOff, Languages, Sun, Moon, ArrowRight, Loader2 } from 'lucide-react';

export default function LoginView() {
  const { login, error, setError } = useAuth();
  const { t, language, setLanguage } = useTranslation();
  const { setTheme, resolvedTheme } = useTheme();

  const [keyInput, setKeyInput] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!keyInput.trim() || isSubmitting) return;

    setIsSubmitting(true);
    try {
      await login(keyInput.trim());
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="flex flex-col h-[100dvh] w-screen bg-[var(--bg-canvas)] text-[var(--text-primary)] select-none relative overflow-hidden">
      {/* Top Utilities */}
      <header className="absolute top-0 right-0 p-3 sm:p-4 flex items-center space-x-2 z-10">
        <button
          type="button"
          onClick={() => setLanguage(language === 'zh' ? 'en' : 'zh')}
          className="p-2 rounded-lg bg-[var(--bg-surface)] hover:bg-[var(--bg-surface-hover)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] border border-[var(--border-subtle)] transition-colors shadow-xs"
          title="Toggle Language"
        >
          <Languages className="w-4 h-4" />
        </button>
        <button
          type="button"
          onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}
          className="p-2 rounded-lg bg-[var(--bg-surface)] hover:bg-[var(--bg-surface-hover)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] border border-[var(--border-subtle)] transition-colors shadow-xs"
          title="Toggle Theme"
        >
          {resolvedTheme === 'dark' ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
        </button>
      </header>

      {/* Centered Login Card */}
      <div className="flex-1 flex items-center justify-center p-4">
        <div className="w-full max-w-sm rounded-2xl bg-[var(--bg-surface)] border border-[var(--border-subtle)] p-6 sm:p-8 shadow-2xl relative">
          {/* Logo & Header */}
          <div className="flex flex-col items-center text-center mb-6">
            <div className="w-12 h-12 rounded-xl bg-emerald-500/15 border border-emerald-500/30 text-emerald-400 flex items-center justify-center font-mono font-bold text-lg mb-3 shadow-inner">
              gt
            </div>
            <h1 className="text-xl font-bold tracking-tight">gt-hub</h1>
            <p className="text-xs text-[var(--text-secondary)] mt-1">
              {t('webTerminal.loginSubtitle', '请输入管理员密钥以访问控制台与终端')}
            </p>
          </div>

          {/* Form */}
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-[var(--text-secondary)] mb-1.5">
                {t('webTerminal.secretKeyLabel', 'Admin Secret Key')}
              </label>
              <div className="relative flex items-center">
                <span className="absolute left-3 text-[var(--text-muted)] pointer-events-none">
                  <Lock className="w-4 h-4" />
                </span>
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={keyInput}
                  onChange={(e) => {
                    setKeyInput(e.target.value);
                    if (error) setError(null);
                  }}
                  placeholder={t('nav.adminKeyPlaceholder', '管理员密钥')}
                  autoFocus
                  required
                  className="w-full pl-9 pr-10 py-2.5 rounded-xl bg-[var(--bg-canvas)] border border-[var(--border-subtle)] focus:border-emerald-500/60 focus:ring-1 focus:ring-emerald-500/50 text-sm font-mono transition-all outline-hidden text-[var(--text-primary)]"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
                  tabIndex={-1}
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            {/* Error Message */}
            {error && (
              <div className="p-2.5 rounded-lg bg-rose-500/10 border border-rose-500/20 text-rose-400 text-xs flex items-start space-x-1.5 animate-fadeIn">
                <KeyRound className="w-4 h-4 shrink-0 mt-0.5" />
                <span>{error}</span>
              </div>
            )}

            {/* Submit Button */}
            <button
              type="submit"
              disabled={isSubmitting || !keyInput.trim()}
              className="w-full py-2.5 px-4 rounded-xl bg-emerald-600 hover:bg-emerald-500 active:bg-emerald-700 text-white font-medium text-sm flex items-center justify-center space-x-2 transition-all disabled:opacity-50 disabled:cursor-not-allowed shadow-md shadow-emerald-950/20"
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>{t('webTerminal.verifying', '正在验证...')}</span>
                </>
              ) : (
                <>
                  <span>{t('nav.login', '进入控制台')}</span>
                  <ArrowRight className="w-4 h-4" />
                </>
              )}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/frontendLoginView.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/LoginView.tsx tests/frontendLoginView.test.ts
git commit -m "feat(auth): add responsive fullscreen LoginView component"
```

---

### Task 4: Integrate Auth Guard in App.tsx & Add Logout / 401 Interceptor

**Files:**
- Modify: `frontend/src/main.tsx`
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/components/UnifiedTerminalView.tsx`
- Test: `tests/terminalAuthGuardIntegration.test.ts`

**Interfaces:**
- Consumes:
  - `useAuth()` in `App.tsx`
  - `onLogout` prop in `UnifiedTerminalView`
- Produces:
  - Conditional rendering: Loading placeholder when `checking`, `LoginView` when `unauthenticated`, `UnifiedTerminalView` when `authenticated`.
  - Logout action button with `LogOut` icon in `UnifiedTerminalView`'s micro top bar.
  - Automatic logout on 401 response from terminal fetch.

- [ ] **Step 1: Write the failing test for App.tsx Auth Guard and UnifiedTerminalView logout**

Create `tests/terminalAuthGuardIntegration.test.ts`:
```ts
import * as fs from 'fs';
import * as path from 'path';

describe('Auth Guard Integration & Logout Mechanism', () => {
  const appPath = path.resolve(__dirname, '../frontend/src/App.tsx');
  const mainPath = path.resolve(__dirname, '../frontend/src/main.tsx');
  const unifiedPath = path.resolve(__dirname, '../frontend/src/components/UnifiedTerminalView.tsx');

  let appContent: string;
  let mainContent: string;
  let unifiedContent: string;

  beforeAll(() => {
    appContent = fs.readFileSync(appPath, 'utf-8');
    mainContent = fs.readFileSync(mainPath, 'utf-8');
    unifiedContent = fs.readFileSync(unifiedPath, 'utf-8');
  });

  it('main.tsx wraps App with AuthProvider', () => {
    expect(mainContent).toContain('<AuthProvider>');
    expect(mainContent).toContain('</AuthProvider>');
  });

  it('App.tsx uses useAuth to guard terminal access', () => {
    expect(appContent).toContain('useAuth()');
    expect(appContent).toContain("<LoginView");
    expect(appContent).toContain("status === 'unauthenticated'");
  });

  it('App.tsx passes onLogout to UnifiedTerminalView', () => {
    expect(appContent).toMatch(/<UnifiedTerminalView[^>]*onLogout=\{logout\}/);
  });

  it('UnifiedTerminalView provides Logout button and handles 401 auto logout', () => {
    expect(unifiedContent).toContain('LogOut');
    expect(unifiedContent).toContain('onLogout');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/terminalAuthGuardIntegration.test.ts`
Expected: FAIL.

- [ ] **Step 3: Update main.tsx, App.tsx, and UnifiedTerminalView.tsx**

1. Update `frontend/src/main.tsx`:
```tsx
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';
import { LanguageProvider } from './i18n/LanguageContext';
import { ThemeProvider } from './theme/ThemeContext';
import { AuthProvider } from './auth/AuthContext';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ThemeProvider>
      <LanguageProvider>
        <AuthProvider>
          <App />
        </AuthProvider>
      </LanguageProvider>
    </ThemeProvider>
  </React.StrictMode>
);
```

2. Update `frontend/src/App.tsx`:
```tsx
import React from 'react';
import UnifiedTerminalView from './components/UnifiedTerminalView';
import LoginView from './components/LoginView';
import { useAuth } from './auth/AuthContext';
import { Loader2 } from 'lucide-react';

export default function App() {
  const { status, adminKey, authRequired, logout } = useAuth();

  if (status === 'checking') {
    return (
      <div className="flex items-center justify-center h-[100dvh] w-screen bg-[var(--bg-canvas)] text-[var(--text-muted)] select-none">
        <Loader2 className="w-6 h-6 animate-spin text-emerald-400" />
      </div>
    );
  }

  if (status === 'unauthenticated') {
    return <LoginView />;
  }

  return (
    <div className="flex flex-col h-[100dvh] w-screen overflow-hidden bg-[var(--bg-canvas)] text-[var(--text-primary)] select-none">
      <UnifiedTerminalView
        adminKey={adminKey}
        isStandalone={true}
        onLogout={authRequired ? logout : undefined}
      />
    </div>
  );
}
```

3. Update `frontend/src/components/UnifiedTerminalView.tsx`:
- Add `LogOut` to lucide-react imports:
  ```tsx
  import {
    ...
    LogOut,
  } from 'lucide-react';
  ```
- Add `onLogout?: () => void;` to `UnifiedTerminalViewProps`.
- In `UnifiedTerminalView`:
  ```tsx
  export interface UnifiedTerminalViewProps {
    adminKey?: string;
    isStandalone?: boolean;
    onEnterStandalone?: () => void;
    onExitStandalone?: () => void;
    onLogout?: () => void;
  }

  export default function UnifiedTerminalView({
    adminKey: propAdminKey,
    isStandalone = true,
    onEnterStandalone,
    onExitStandalone,
    onLogout,
  }: UnifiedTerminalViewProps) {
  ```
- In the top bar action buttons (near Theme Switcher, before or after it), render the Logout button if `onLogout` is provided:
  ```tsx
  {onLogout && (
    <button
      type="button"
      onClick={onLogout}
      className="p-1 sm:p-1.5 rounded-lg bg-white/[0.04] hover:bg-rose-500/20 text-slate-400 hover:text-rose-300 border border-white/[0.06] hover:border-rose-500/30 transition-all"
      title={t('nav.logout', '退出登录')}
    >
      <LogOut className="w-3.5 h-3.5" />
    </button>
  )}
  ```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/terminalAuthGuardIntegration.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/main.tsx frontend/src/App.tsx frontend/src/components/UnifiedTerminalView.tsx tests/terminalAuthGuardIntegration.test.ts
git commit -m "feat(auth): integrate Auth Guard into App.tsx and add logout action to UnifiedTerminalView"
```

---

### Task 5: Regression Suite Verification & Build Validation

**Files:**
- Test: All suites in `tests/*.test.ts`
- Build: `frontend/`

- [ ] **Step 1: Run complete Jest test suite**

Run: `npm test`
Expected: All 89 test suites pass cleanly.

- [ ] **Step 2: Run frontend production build**

Run: `cd frontend && npm run build && cd ..`
Expected: `tsc --noEmit && vite build` builds cleanly with 0 errors.

- [ ] **Step 3: Commit**

```bash
git commit --allow-empty -m "chore: verify auth guard regression test suite and frontend build pass"
```

---

## Plan Self-Review Checklist

- [x] **Spec coverage**:
  - `/api/auth/status` and `/api/auth/login` implemented in Task 1.
  - Zero password detection implemented in Task 1 & Task 2.
  - Auth Guard gaurding `App.tsx` implemented in Task 4.
  - Fullscreen `LoginView` implemented in Task 3.
  - Logout and session cleanup implemented in Task 2 & Task 4.
  - All test suites passing and build validated in Task 5.
- [x] **Placeholder scan**: All file paths, types, interfaces, code blocks, and test commands are completely filled in with concrete implementation code.
- [x] **Type consistency**: `AuthStatus`, `AuthContextValue`, `UnifiedTerminalViewProps.onLogout` match across all modules and tests.
- [x] **Review Focus**:
  - Unconfigured key bypass tested in Task 1 (`authRequired: false`).
  - Invalid key submission tested in Task 1 & Task 3.
  - Valid key transition tested in Task 1, 2, and 4.
  - Logout persistence & cleanup tested in Task 2 and Task 4.
  - Theme/Language switching on login page tested in Task 3.
