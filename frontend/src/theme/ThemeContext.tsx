import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';

export type ThemeMode = 'system' | 'dark' | 'light';
export type ResolvedTheme = 'dark' | 'light';

export interface ThemeContextType {
  theme: ThemeMode;
  resolvedTheme: ResolvedTheme;
  setTheme: (theme: ThemeMode) => void;
  toggleTheme: () => void;
}

const THEME_STORAGE_KEY = 'gemini_proxy_theme';

export function parseThemeToken(raw: unknown): ThemeMode | null {
  if (typeof raw === 'boolean') {
    return raw ? 'dark' : 'light';
  }
  if (typeof raw !== 'string') return null;
  const normalized = raw.trim().toLowerCase();
  if (['dark', 'night', 'true'].includes(normalized)) return 'dark';
  if (['light', 'day', 'false'].includes(normalized)) return 'light';
  if (['auto', 'system'].includes(normalized)) return 'system';
  return null;
}

export function parseThemeFromUrl(search?: string, hash?: string): ThemeMode | null {
  const s = search !== undefined ? search : typeof window !== 'undefined' ? window.location.search : '';
  const h = hash !== undefined ? hash : typeof window !== 'undefined' ? window.location.hash : '';

  const checkParams = (qs: string): ThemeMode | null => {
    if (!qs) return null;
    const query = qs.startsWith('?') ? qs.slice(1) : qs;
    const params = new URLSearchParams(query);
    const keys = ['theme', 'colorScheme', 'colorMode', 'color-scheme', 'color_mode'];
    for (const key of keys) {
      const val = params.get(key);
      if (val !== null) {
        const token = parseThemeToken(val);
        if (token) return token;
      }
    }
    return null;
  };

  const fromSearch = checkParams(s);
  if (fromSearch) return fromSearch;

  if (h) {
    const qIndex = h.indexOf('?');
    if (qIndex !== -1) {
      const fromHash = checkParams(h.slice(qIndex + 1));
      if (fromHash) return fromHash;
    }
  }

  return null;
}

export function parseThemeFromMessage(data: unknown): ThemeMode | null {
  if (data === null || data === undefined) return null;

  let payload = data;
  if (typeof payload === 'string') {
    const trimmed = payload.trim();
    const prefixMatch = trimmed.match(/^theme:(.+)$/i);
    if (prefixMatch) {
      return parseThemeToken(prefixMatch[1]);
    }
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      try {
        payload = JSON.parse(trimmed);
      } catch {
        return null;
      }
    } else {
      return null;
    }
  }

  if (typeof payload === 'object' && payload !== null) {
    const obj = payload as Record<string, unknown>;
    if (typeof obj.isDark === 'boolean') {
      return obj.isDark ? 'dark' : 'light';
    }
    const candidates = [obj.theme, obj.value, obj.mode, obj.colorMode, obj.colorScheme];
    for (const cand of candidates) {
      if (cand !== undefined && cand !== null) {
        const token = parseThemeToken(cand);
        if (token) return token;
      }
    }
  }

  return null;
}

export function parseLuminanceTheme(cssColor: string | null | undefined): ResolvedTheme | null {
  if (!cssColor) return null;
  const color = cssColor.trim().toLowerCase();
  if (color === 'transparent' || color === 'inherit' || color === 'initial' || color === 'unset') {
    return null;
  }

  // Hex color (#RGB, #RGBA, #RRGGBB, #RRGGBBAA)
  if (color.startsWith('#')) {
    const hex = color.slice(1);
    let r = 0;
    let g = 0;
    let b = 0;
    let a = 1;
    if (hex.length === 3 || hex.length === 4) {
      r = parseInt(hex[0] + hex[0], 16);
      g = parseInt(hex[1] + hex[1], 16);
      b = parseInt(hex[2] + hex[2], 16);
      if (hex.length === 4) {
        a = parseInt(hex[3] + hex[3], 16) / 255;
      }
    } else if (hex.length === 6 || hex.length === 8) {
      r = parseInt(hex.slice(0, 2), 16);
      g = parseInt(hex.slice(2, 4), 16);
      b = parseInt(hex.slice(4, 6), 16);
      if (hex.length === 8) {
        a = parseInt(hex.slice(6, 8), 16) / 255;
      }
    } else {
      return null;
    }
    if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b) || Number.isNaN(a)) return null;
    if (a <= 0.1) return null;
    const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return lum < 0.5 ? 'dark' : 'light';
  }

  // rgb(...) or rgba(...)
  const rgbMatch = color.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?\s*\)$/);
  if (rgbMatch) {
    const r = parseFloat(rgbMatch[1]);
    const g = parseFloat(rgbMatch[2]);
    const b = parseFloat(rgbMatch[3]);
    let a = 1;
    if (rgbMatch[4] !== undefined) {
      const alphaRaw = rgbMatch[4];
      if (alphaRaw.endsWith('%')) {
        a = parseFloat(alphaRaw) / 100;
      } else {
        a = parseFloat(alphaRaw);
      }
    }
    if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b) || Number.isNaN(a)) return null;
    if (a <= 0.1) return null;
    const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return lum < 0.5 ? 'dark' : 'light';
  }

  return null;
}

export function detectElementTheme(
  el: Element | null,
  computedStyle?: Partial<CSSStyleDeclaration> | null
): ResolvedTheme | null {
  if (!el) return null;

  // 1. Check classList
  if (el.classList) {
    if (el.classList.contains('dark') || el.classList.contains('theme-dark')) {
      return 'dark';
    }
    if (el.classList.contains('light') || el.classList.contains('theme-light')) {
      return 'light';
    }
  }

  // 2. Check theme-related attributes
  if (typeof el.getAttribute === 'function') {
    const attrs = ['data-theme', 'data-color-mode', 'data-color-scheme', 'data-bs-theme', 'theme'];
    for (const attr of attrs) {
      const val = el.getAttribute(attr);
      if (val) {
        const token = parseThemeToken(val);
        if (token === 'dark' || token === 'light') {
          return token;
        }
      }
    }
  }

  // 3. Check style.colorScheme and computedStyle.colorScheme
  const elStyle = (el as any).style;
  const colorScheme = computedStyle?.colorScheme || elStyle?.colorScheme;
  if (colorScheme) {
    const token = parseThemeToken(colorScheme);
    if (token === 'dark' || token === 'light') {
      return token;
    }
  }

  // 4. Check computedStyle.backgroundColor or inline style.backgroundColor
  const bgColor = computedStyle?.backgroundColor || elStyle?.backgroundColor;
  if (bgColor) {
    const lumTheme = parseLuminanceTheme(bgColor);
    if (lumTheme) {
      return lumTheme;
    }
  }

  return null;
}

export function isEmbeddedIframe(win?: any): boolean {
  const w = win !== undefined ? win : typeof window !== 'undefined' ? window : null;
  if (!w) return false;
  try {
    return Boolean(w.self && w.top && w.self !== w.top);
  } catch {
    // Cross-origin access to top throws SecurityError, which means it IS in an iframe
    return true;
  }
}

export function detectParentDocumentTheme(win?: any): ResolvedTheme | null {
  const w = win !== undefined ? win : typeof window !== 'undefined' ? window : null;
  if (!w) return null;
  try {
    if (!w.parent || w.parent === w) return null;
    const parentDoc = w.parent.document;
    if (!parentDoc) return null;

    const getStyle = (el: any) => {
      try {
        return typeof w.parent.getComputedStyle === 'function' ? w.parent.getComputedStyle(el) : null;
      } catch {
        return null;
      }
    };

    if (parentDoc.documentElement) {
      const docTheme = detectElementTheme(parentDoc.documentElement, getStyle(parentDoc.documentElement));
      if (docTheme) return docTheme;
    }

    if (parentDoc.body) {
      const bodyTheme = detectElementTheme(parentDoc.body, getStyle(parentDoc.body));
      if (bodyTheme) return bodyTheme;
    }

    return null;
  } catch {
    // Cross-origin SecurityError or access restriction
    return null;
  }
}

export function getInitialThemeMode(win?: any, storage?: Pick<Storage, 'getItem'> | null): ThemeMode {
  const w = win !== undefined ? win : typeof window !== 'undefined' ? window : null;

  // 1. Explicit theme from URL query or hash query
  const urlTheme = parseThemeFromUrl(w?.location?.search, w?.location?.hash);
  if (urlTheme) {
    return urlTheme;
  }

  // 2. In an embedded iframe, default to 'system' to dynamically match the host
  if (isEmbeddedIframe(w)) {
    return 'system';
  }

  // 3. Standalone mode: check saved preference in localStorage
  try {
    const s = storage !== undefined ? storage : typeof localStorage !== 'undefined' ? localStorage : null;
    if (s) {
      const saved = s.getItem(THEME_STORAGE_KEY);
      const parsed = parseThemeToken(saved);
      if (parsed) return parsed;
    }
  } catch {
    // Ignore storage errors
  }

  return 'system';
}

export function resolveAutoTheme(win?: any): ResolvedTheme {
  const w = win !== undefined ? win : typeof window !== 'undefined' ? window : null;
  if (!w) return 'dark';

  // 1. Explicit theme from URL
  const urlTheme = parseThemeFromUrl(w?.location?.search, w?.location?.hash);
  if (urlTheme === 'dark' || urlTheme === 'light') {
    return urlTheme;
  }

  // 2. Parent document theme (for embedded iframes)
  const parentTheme = detectParentDocumentTheme(w);
  if (parentTheme) {
    return parentTheme;
  }

  // 3. System matchMedia preference
  if (typeof w.matchMedia === 'function') {
    try {
      const mq = w.matchMedia('(prefers-color-scheme: dark)');
      return mq && mq.matches ? 'dark' : 'light';
    } catch {
      // Fallback
    }
  }

  return 'dark';
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

export const ThemeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [theme, setThemeState] = useState<ThemeMode>(() => getInitialThemeMode());
  const [autoResolvedTheme, setAutoResolvedTheme] = useState<ResolvedTheme>(() => resolveAutoTheme());
  const [externalThemeOverride, setExternalThemeOverride] = useState<ResolvedTheme | null>(null);

  const resolvedTheme: ResolvedTheme = externalThemeOverride ?? (theme === 'system' ? autoResolvedTheme : theme);

  const setTheme = useCallback((newTheme: ThemeMode) => {
    setExternalThemeOverride(null);
    setThemeState(newTheme);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, newTheme);
    } catch {
      // Ignore storage errors
    }
  }, []);

  const toggleTheme = useCallback(() => {
    setExternalThemeOverride(null);
    const next: ThemeMode = resolvedTheme === 'dark' ? 'light' : 'dark';
    setThemeState(next);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Ignore storage errors
    }
  }, [resolvedTheme]);

  // Synchronize documentElement classes, attributes, and colorScheme
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;

    root.classList.toggle('dark', resolvedTheme === 'dark');
    root.setAttribute('data-theme', resolvedTheme);
    root.style.colorScheme = resolvedTheme;
  }, [resolvedTheme]);

  // Reactive listeners for 4-tier detection
  useEffect(() => {
    if (typeof window === 'undefined') return;

    const updateAuto = () => {
      setAutoResolvedTheme(resolveAutoTheme());
    };

    // 1. matchMedia listener
    let mql: MediaQueryList | null = null;
    let mqlHandler: ((e: MediaQueryListEvent | MediaQueryList) => void) | null = null;
    if (typeof window.matchMedia === 'function') {
      try {
        mql = window.matchMedia('(prefers-color-scheme: dark)');
        mqlHandler = () => {
          updateAuto();
        };
        if (typeof mql.addEventListener === 'function') {
          mql.addEventListener('change', mqlHandler);
        } else if (typeof (mql as any).addListener === 'function') {
          (mql as any).addListener(mqlHandler);
        }
      } catch {
        // Ignore matchMedia errors
      }
    }

    // 2. Same-origin parent DOM MutationObserver
    let observer: MutationObserver | null = null;
    try {
      if (window.parent && window.parent !== window && window.parent.document) {
        const parentDoc = window.parent.document;
        observer = new MutationObserver(() => {
          updateAuto();
        });
        const config: MutationObserverInit = {
          attributes: true,
          attributeFilter: [
            'class',
            'style',
            'data-theme',
            'data-color-mode',
            'data-color-scheme',
            'data-bs-theme',
            'theme',
          ],
        };
        if (parentDoc.documentElement) {
          observer.observe(parentDoc.documentElement, config);
        }
        if (parentDoc.body) {
          observer.observe(parentDoc.body, config);
        }
      }
    } catch {
      // Cross-origin SecurityError, ignore
    }

    // 3. postMessage listener
    const handleMessage = (event: MessageEvent) => {
      try {
        const parsed = parseThemeFromMessage(event.data);
        if (!parsed) return;
        if (parsed === 'system') {
          setExternalThemeOverride(null);
          setThemeState('system');
          updateAuto();
        } else {
          setExternalThemeOverride(parsed);
          setAutoResolvedTheme(parsed);
        }
      } catch {
        // Ignore invalid message payloads
      }
    };
    window.addEventListener('message', handleMessage);

    // 4. Single-page navigation / URL hash & query changes
    const handleLocationChange = () => {
      updateAuto();
    };
    window.addEventListener('popstate', handleLocationChange);
    window.addEventListener('hashchange', handleLocationChange);

    return () => {
      if (mql && mqlHandler) {
        if (typeof mql.removeEventListener === 'function') {
          mql.removeEventListener('change', mqlHandler);
        } else if (typeof (mql as any).removeListener === 'function') {
          (mql as any).removeListener(mqlHandler);
        }
      }
      if (observer) {
        observer.disconnect();
      }
      window.removeEventListener('message', handleMessage);
      window.removeEventListener('popstate', handleLocationChange);
      window.removeEventListener('hashchange', handleLocationChange);
    };
  }, []);

  return (
    <ThemeContext.Provider value={{ theme, resolvedTheme, setTheme, toggleTheme }}>
      {children}
    </ThemeContext.Provider>
  );
};

export const useTheme = (): ThemeContextType => {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
};
