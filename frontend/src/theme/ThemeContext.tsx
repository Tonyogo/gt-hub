import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';

export type ThemeMode = 'system' | 'dark' | 'light';
export type ResolvedTheme = 'dark' | 'light';

export interface ThemeContextType {
  theme: ThemeMode;
  resolvedTheme: ResolvedTheme;
  setTheme: (theme: ThemeMode) => void;
  toggleTheme: () => void;
}

const THEME_STORAGE_KEY = 'gt_hub_theme_mode';

const DARK_THEME_TOKENS = new Set([
  'dark',
  'night',
  'true',
  'dark-mode',
  'dark_mode',
  'is-dark',
  'theme-dark',
  'dark-theme',
  'only dark',
  'dark light',
  'dracula',
  'sunset',
  'dim',
  'business',
  'black',
  'luxury',
  'coffee',
  'forest',
  'synthwave',
  'cyberpunk',
  'abyss',
  'halloween',
  'mocha',
  'frappe',
  'macchiato',
]);

const LIGHT_THEME_TOKENS = new Set([
  'light',
  'day',
  'false',
  'light-mode',
  'light_mode',
  'is-light',
  'theme-light',
  'light-theme',
  'only light',
  'light dark',
  'cupcake',
  'winter',
  'nord',
  'corporate',
  'lemonade',
  'pastel',
  'fantasy',
  'wireframe',
  'cmyk',
  'autumn',
  'acid',
  'bumblebee',
  'emerald',
  'valentine',
  'garden',
  'lofi',
  'retro',
  'latte',
]);

const PARENT_STORAGE_KEYS = [
  'gt_hub_theme_mode',
  'zashboard-theme',
  'vueuse-color-scheme',
  'theme',
  'color-scheme',
  'color-mode',
  'colorMode',
  'colorScheme',
  'vitepress-theme-appearance',
  'next-theme',
  'naive-theme',
  'app-theme',
  'ui-theme',
  'darkMode',
  'isDark',
];

export function parseThemeToken(raw: unknown): ThemeMode | null {
  if (typeof raw === 'boolean') {
    return raw ? 'dark' : 'light';
  }
  if (typeof raw !== 'string') return null;
  const normalized = raw.trim().toLowerCase();
  if (!normalized || ['normal', 'inherit', 'initial', 'unset', 'none'].includes(normalized)) {
    return null;
  }
  if (['auto', 'system', 'default'].includes(normalized)) return 'system';
  if (DARK_THEME_TOKENS.has(normalized)) return 'dark';
  if (LIGHT_THEME_TOKENS.has(normalized)) return 'light';

  // Composite token matching (e.g. "github-dark", "tokyo-night", "solarized-light", "v-theme--dark")
  const parts = normalized.split(/[\s_-]+/).filter(Boolean);
  for (const part of parts) {
    if (part === 'dark' || part === 'night' || part === 'dracula' || part === 'mocha') {
      return 'dark';
    }
    if (part === 'light' || part === 'day' || part === 'latte') {
      return 'light';
    }
  }

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

function parseAlpha(alphaRaw: string | undefined): number {
  if (alphaRaw === undefined) return 1;
  const trimmed = alphaRaw.trim();
  if (!trimmed || trimmed === 'none') return 0;
  if (trimmed.endsWith('%')) {
    return parseFloat(trimmed) / 100;
  }
  return parseFloat(trimmed);
}

export function parseLuminanceTheme(cssColor: string | null | undefined): ResolvedTheme | null {
  if (!cssColor) return null;
  const color = cssColor.trim().toLowerCase();
  if (
    !color ||
    color === 'transparent' ||
    color === 'inherit' ||
    color === 'initial' ||
    color === 'unset' ||
    color === 'none'
  ) {
    return null;
  }

  // 1. Hex color (#RGB, #RGBA, #RRGGBB, #RRGGBBAA)
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

  // 2. rgb(...) or rgba(...)
  const rgbMatch = color.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?\s*\)$/);
  if (rgbMatch) {
    const r = parseFloat(rgbMatch[1]);
    const g = parseFloat(rgbMatch[2]);
    const b = parseFloat(rgbMatch[3]);
    const a = parseAlpha(rgbMatch[4]);
    if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b) || Number.isNaN(a)) return null;
    if (a <= 0.1) return null;
    const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return lum < 0.5 ? 'dark' : 'light';
  }

  // 3. oklch(L C H [/ A]) or oklab(L a b [/ A]) — supports 'none' channel keywords in WebKit/Blink
  const oklMatch = color.match(
    /^okl(?:ch|ab)\(\s*([\d.]+)(%?)\s+(?:[\d.-]+%?|none)\s+(?:[\d.-]+(?:deg|grad|rad|turn)?|none)(?:\s*\/\s*([\d.]+%?|none))?\s*\)$/
  );
  if (oklMatch) {
    let l = parseFloat(oklMatch[1]);
    if (oklMatch[2] === '%' || l > 1) {
      l = l / 100;
    }
    const a = parseAlpha(oklMatch[3]);
    if (Number.isNaN(l) || Number.isNaN(a) || a <= 0.1) return null;
    return l < 0.5 ? 'dark' : 'light';
  }

  // 4. hsl(H, S%, L%) or hsla(H, S%, L%, A)
  const hslMatch = color.match(
    /^hsla?\(\s*(?:[\d.]+(?:deg|grad|rad|turn)?|none)[,\s]+(?:[\d.]+%?|none)[,\s]+([\d.]+)%?(?:[,\s/]+([\d.]+%?|none))?\s*\)$/
  );
  if (hslMatch) {
    const l = parseFloat(hslMatch[1]) / 100;
    const a = parseAlpha(hslMatch[2]);
    if (Number.isNaN(l) || Number.isNaN(a) || a <= 0.1) return null;
    return l < 0.5 ? 'dark' : 'light';
  }

  // 5. lab(L a b [/ A]) or lch(L C H [/ A])
  const labMatch = color.match(
    /^l(?:ab|ch)\(\s*([\d.]+)(%?)\s+(?:[\d.-]+%?|none)\s+(?:[\d.-]+(?:deg|grad|rad|turn)?|none)(?:\s*\/\s*([\d.]+%?|none))?\s*\)$/
  );
  if (labMatch) {
    const l = parseFloat(labMatch[1]) / 100;
    const a = parseAlpha(labMatch[3]);
    if (Number.isNaN(l) || Number.isNaN(a) || a <= 0.1) return null;
    return l < 0.5 ? 'dark' : 'light';
  }

  // 6. color(srgb r g b [/ a]) or color(display-p3 r g b [/ a])
  const colorFnMatch = color.match(
    /^color\(\s*[a-z0-9-]+\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+%?|none))?\s*\)$/
  );
  if (colorFnMatch) {
    const r = parseFloat(colorFnMatch[1]);
    const g = parseFloat(colorFnMatch[2]);
    const b = parseFloat(colorFnMatch[3]);
    const a = parseAlpha(colorFnMatch[4]);
    if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b) || Number.isNaN(a) || a <= 0.1) return null;
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    return lum < 0.5 ? 'dark' : 'light';
  }

  return null;
}

function detectElementClassOrAttrTheme(el: Element | null): ResolvedTheme | null {
  if (!el) return null;

  // 1. Check classList
  if (el.classList && typeof el.classList.contains === 'function') {
    const darkClasses = [
      'dark',
      'theme-dark',
      'dark-mode',
      'is-dark',
      'v-theme--dark',
      'chakra-ui-dark',
      'ant-layout-dark',
      'bp4-dark',
      'bp5-dark',
    ];
    for (const cls of darkClasses) {
      if (el.classList.contains(cls)) return 'dark';
    }
    const lightClasses = [
      'light',
      'theme-light',
      'light-mode',
      'is-light',
      'v-theme--light',
      'chakra-ui-light',
    ];
    for (const cls of lightClasses) {
      if (el.classList.contains(cls)) return 'light';
    }
  }

  // 2. Check theme-related attributes
  if (typeof el.getAttribute === 'function') {
    const attrs = [
      'data-theme',
      'data-color-mode',
      'data-color-scheme',
      'data-bs-theme',
      'data-mui-color-scheme',
      'data-joy-color-scheme',
      'data-darkmode',
      'data-dark',
      'data-mode',
      'data-appearance',
      'theme',
      'color-scheme',
    ];
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

  // 3. Check inline style.colorScheme on this specific element (not inherited computedStyle)
  const elStyle = (el as any).style;
  if (elStyle?.colorScheme) {
    const token = parseThemeToken(elStyle.colorScheme);
    if (token === 'dark' || token === 'light') {
      return token;
    }
  }

  return null;
}

function detectElementComputedColorScheme(
  computedStyle?: Partial<CSSStyleDeclaration> | null
): ResolvedTheme | null {
  if (!computedStyle?.colorScheme) return null;
  const token = parseThemeToken(computedStyle.colorScheme);
  if (token === 'dark' || token === 'light') {
    return token;
  }
  return null;
}

function detectElementBackgroundTheme(
  el: Element | null,
  computedStyle?: Partial<CSSStyleDeclaration> | null
): ResolvedTheme | null {
  if (!el) return null;
  const elStyle = (el as any).style;
  const bgColor = computedStyle?.backgroundColor || elStyle?.backgroundColor;
  if (bgColor) {
    return parseLuminanceTheme(bgColor);
  }
  return null;
}

export function detectElementTheme(
  el: Element | null,
  computedStyle?: Partial<CSSStyleDeclaration> | null
): ResolvedTheme | null {
  if (!el) return null;
  return (
    detectElementClassOrAttrTheme(el) ??
    detectElementComputedColorScheme(computedStyle) ??
    detectElementBackgroundTheme(el, computedStyle)
  );
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

    // Build candidate element list in inside-out order:
    // 1. Ancestors of window.frameElement (closest wrapper around the iframe first)
    // 2. App root / theme containers (#app, #root, [data-theme], etc.)
    // 3. parentDoc.body
    // 4. parentDoc.documentElement
    const candidates: Element[] = [];
    const pushUnique = (el: any) => {
      if (el && !candidates.includes(el)) {
        candidates.push(el);
      }
    };

    try {
      let curr = w.frameElement ? w.frameElement.parentElement : null;
      let depth = 0;
      while (curr && depth < 15) {
        pushUnique(curr);
        curr = curr.parentElement;
        depth++;
      }
    } catch {
      // Ignore frameElement traversal errors
    }

    try {
      if (typeof parentDoc.querySelectorAll === 'function') {
        const nodes = parentDoc.querySelectorAll(
          '#app, #root, main, [role="main"], .ant-layout, .ant-app, .n-layout, .n-config-provider, .v-application, .el-container, [data-theme], [data-color-mode], [data-color-scheme], [data-bs-theme], [data-darkmode], .dark, .theme-dark, .dark-mode, .is-dark'
        );
        if (nodes && typeof nodes.length === 'number') {
          for (let i = 0; i < nodes.length; i++) {
            pushUnique(nodes[i]);
          }
        }
      } else if (typeof parentDoc.querySelector === 'function') {
        const node = parentDoc.querySelector(
          '#app, #root, main, [data-theme], [data-color-mode], [data-color-scheme], [data-bs-theme], [data-darkmode]'
        );
        if (node) pushUnique(node);
      }
    } catch {
      // Ignore querySelector errors
    }

    pushUnique(parentDoc.body);
    pushUnique(parentDoc.documentElement);

    // Stage 1: Check ALL candidate elements for explicit DOM classes, data-* attributes, or inline style.colorScheme
    // (does not check inherited computedStyle.colorScheme or backgroundColor so default white html never masks dark body/#app)
    for (const el of candidates) {
      const explicitTheme = detectElementClassOrAttrTheme(el);
      if (explicitTheme) return explicitTheme;
    }

    // Stage 2: Check same-origin parent.localStorage for common framework theme keys
    try {
      const parentStorage = w.parent.localStorage;
      if (parentStorage && typeof parentStorage.getItem === 'function') {
        for (const key of PARENT_STORAGE_KEYS) {
          const rawVal = parentStorage.getItem(key);
          if (rawVal) {
            const parsed = parseThemeToken(rawVal) ?? parseThemeFromMessage(rawVal);
            if (parsed === 'dark' || parsed === 'light') {
              return parsed;
            }
          }
        }
      }
    } catch {
      // Ignore storage access errors
    }

    // Stage 3: Check opaque background luminance across layout candidates.
    // If ANY layout/container candidate has an opaque dark background, the host layout is dark
    // (even if html/body has a fallback white reset background).
    let hasOpaqueLightBg = false;
    for (const el of candidates) {
      const bgTheme = detectElementBackgroundTheme(el, getStyle(el));
      if (bgTheme === 'dark') {
        return 'dark';
      }
      if (bgTheme === 'light') {
        hasOpaqueLightBg = true;
      }
    }
    if (hasOpaqueLightBg) {
      return 'light';
    }

    // Stage 4: Check computedStyle.colorScheme on documentElement or body
    for (const el of [parentDoc.documentElement, parentDoc.body]) {
      if (el) {
        const csTheme = detectElementComputedColorScheme(getStyle(el));
        if (csTheme) return csTheme;
      }
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

  // 3. Standalone mode: check saved preference in localStorage (using gt_hub_theme_mode to avoid legacy 2-state lock)
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

function applyThemeToRootDocument(resolved: ResolvedTheme): void {
  if (typeof document === 'undefined' || !document.documentElement) return;
  const root = document.documentElement;
  root.classList.toggle('dark', resolved === 'dark');
  root.setAttribute('data-theme', resolved);
  root.style.colorScheme = resolved;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

export const ThemeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [theme, setThemeState] = useState<ThemeMode>(() => getInitialThemeMode());
  const [autoResolvedTheme, setAutoResolvedTheme] = useState<ResolvedTheme>(() => resolveAutoTheme());
  const [externalThemeOverride, setExternalThemeOverride] = useState<ResolvedTheme | null>(null);

  const resolvedTheme: ResolvedTheme = externalThemeOverride ?? (theme === 'system' ? autoResolvedTheme : theme);

  // Apply synchronously during render so child effects (e.g. Xterm/Monaco) see the active theme immediately
  applyThemeToRootDocument(resolvedTheme);

  const setTheme = useCallback((newTheme: ThemeMode) => {
    setExternalThemeOverride(null);
    setThemeState(newTheme);
    try {
      if (newTheme === 'system') {
        localStorage.removeItem(THEME_STORAGE_KEY);
      } else {
        localStorage.setItem(THEME_STORAGE_KEY, newTheme);
      }
    } catch {
      // Ignore storage errors
    }
  }, []);

  const toggleTheme = useCallback(() => {
    setExternalThemeOverride(null);
    const nextResolved: ResolvedTheme = resolvedTheme === 'dark' ? 'light' : 'dark';
    const currentAuto = resolveAutoTheme();
    setAutoResolvedTheme(currentAuto);

    // If the user toggles back to match the outer host/system theme, restore 'system' auto-follow mode
    const nextMode: ThemeMode = nextResolved === currentAuto ? 'system' : nextResolved;
    setThemeState(nextMode);
    try {
      if (nextMode === 'system') {
        localStorage.removeItem(THEME_STORAGE_KEY);
      } else {
        localStorage.setItem(THEME_STORAGE_KEY, nextMode);
      }
    } catch {
      // Ignore storage errors
    }
  }, [resolvedTheme]);

  // Synchronize documentElement classes, attributes, and colorScheme
  useEffect(() => {
    applyThemeToRootDocument(resolvedTheme);
  }, [resolvedTheme]);

  // Reactive listeners for 4-tier detection
  useEffect(() => {
    if (typeof window === 'undefined') return;

    const updateAuto = (syncToSystem = false) => {
      if (syncToSystem) {
        setExternalThemeOverride(null);
        setThemeState('system');
      }
      setAutoResolvedTheme(resolveAutoTheme());
    };

    // 1. matchMedia listener
    let mql: MediaQueryList | null = null;
    let mqlHandler: ((e: MediaQueryListEvent | MediaQueryList) => void) | null = null;
    if (typeof window.matchMedia === 'function') {
      try {
        mql = window.matchMedia('(prefers-color-scheme: dark)');
        mqlHandler = () => {
          updateAuto(true);
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

    // 2. Same-origin parent DOM MutationObserver & parent storage listener
    let observer: MutationObserver | null = null;
    let parentWin: Window | null = null;
    const handleParentStorage = () => {
      updateAuto(true);
    };
    try {
      if (window.parent && window.parent !== window && window.parent.document) {
        parentWin = window.parent;
        const parentDoc = window.parent.document;
        observer = new MutationObserver(() => {
          updateAuto(true);
        });
        const config: MutationObserverInit = {
          attributes: true,
          subtree: true,
          attributeFilter: [
            'class',
            'style',
            'data-theme',
            'data-color-mode',
            'data-color-scheme',
            'data-bs-theme',
            'data-mui-color-scheme',
            'data-joy-color-scheme',
            'data-darkmode',
            'data-dark',
            'data-mode',
            'data-appearance',
            'theme',
            'color-scheme',
          ],
        };
        if (parentDoc.documentElement) {
          observer.observe(parentDoc.documentElement, config);
        } else if (parentDoc.body) {
          observer.observe(parentDoc.body, config);
        }
        parentWin.addEventListener('storage', handleParentStorage);
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

    // 4. Single-page navigation / URL hash & query changes & storage changes
    const handleLocationChange = () => {
      updateAuto();
    };
    window.addEventListener('popstate', handleLocationChange);
    window.addEventListener('hashchange', handleLocationChange);
    window.addEventListener('storage', handleLocationChange);

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
      if (parentWin) {
        try {
          parentWin.removeEventListener('storage', handleParentStorage);
        } catch {
          // Ignore
        }
      }
      window.removeEventListener('message', handleMessage);
      window.removeEventListener('popstate', handleLocationChange);
      window.removeEventListener('hashchange', handleLocationChange);
      window.removeEventListener('storage', handleLocationChange);
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
