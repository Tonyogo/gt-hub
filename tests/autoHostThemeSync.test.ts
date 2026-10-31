import {
  parseThemeToken,
  parseThemeFromUrl,
  parseThemeFromMessage,
  parseLuminanceTheme,
  detectElementTheme,
  detectParentDocumentTheme,
  isEmbeddedIframe,
  getInitialThemeMode,
  resolveAutoTheme,
} from '../frontend/src/theme/ThemeContext';

describe('Auto System & Embedded Host Theme Sync Engine', () => {
  test('parseThemeToken normalizes dark, light, system/auto, composite tokens, and DaisyUI/Zashboard theme names', () => {
    expect(parseThemeToken('dark')).toBe('dark');
    expect(parseThemeToken('NIGHT')).toBe('dark');
    expect(parseThemeToken('dark-mode')).toBe('dark');
    expect(parseThemeToken('is-dark')).toBe('dark');
    expect(parseThemeToken('only dark')).toBe('dark');
    expect(parseThemeToken('dark light')).toBe('dark');
    expect(parseThemeToken('github-dark')).toBe('dark');
    expect(parseThemeToken('dracula')).toBe('dark');
    expect(parseThemeToken('sunset')).toBe('dark');
    expect(parseThemeToken('dim')).toBe('dark');
    expect(parseThemeToken('business')).toBe('dark');
    expect(parseThemeToken('light')).toBe('light');
    expect(parseThemeToken('day')).toBe('light');
    expect(parseThemeToken('light-mode')).toBe('light');
    expect(parseThemeToken('only light')).toBe('light');
    expect(parseThemeToken('cupcake')).toBe('light');
    expect(parseThemeToken('winter')).toBe('light');
    expect(parseThemeToken('nord')).toBe('light');
    expect(parseThemeToken('auto')).toBe('system');
    expect(parseThemeToken('system')).toBe('system');
    expect(parseThemeToken('invalid')).toBeNull();
    expect(parseThemeToken(null)).toBeNull();
  });

  test('parseThemeFromUrl extracts theme from query string or hash query', () => {
    expect(parseThemeFromUrl('?theme=light', '')).toBe('light');
    expect(parseThemeFromUrl('?foo=1&colorScheme=dark', '')).toBe('dark');
    expect(parseThemeFromUrl('', '#/terminal?theme=auto')).toBe('system');
    expect(parseThemeFromUrl('?other=1', '')).toBeNull();
  });

  test('parseThemeFromMessage parses zashboard/portal postMessage formats and ignores unrelated traffic', () => {
    expect(parseThemeFromMessage({ type: 'theme-change', theme: 'light' })).toBe('light');
    expect(parseThemeFromMessage({ type: 'zashboard-theme', value: 'dark' })).toBe('dark');
    expect(parseThemeFromMessage({ theme: 'light' })).toBe('light');
    expect(parseThemeFromMessage({ colorMode: 'dark' })).toBe('dark');
    expect(parseThemeFromMessage({ isDark: false })).toBe('light');
    expect(parseThemeFromMessage({ isDark: true })).toBe('dark');
    expect(parseThemeFromMessage(JSON.stringify({ type: 'set-theme', theme: 'light' }))).toBe('light');
    expect(parseThemeFromMessage('theme:light')).toBe('light');
    // Unrelated messages must return null
    expect(parseThemeFromMessage({ type: 'monaco-worker', data: 123 })).toBeNull();
    expect(parseThemeFromMessage('random-string')).toBeNull();
  });

  test('parseLuminanceTheme classifies rgb, hex, oklch, oklab, hsl, and color(srgb) backgrounds and ignores transparent colors', () => {
    expect(parseLuminanceTheme('rgb(9, 13, 22)')).toBe('dark');
    expect(parseLuminanceTheme('rgb(255, 255, 255)')).toBe('light');
    expect(parseLuminanceTheme('#090d16')).toBe('dark');
    expect(parseLuminanceTheme('#f8fafc')).toBe('light');
    expect(parseLuminanceTheme('oklch(0.21 0.034 264.665)')).toBe('dark');
    expect(parseLuminanceTheme('oklch(0.15 0 none)')).toBe('dark');
    expect(parseLuminanceTheme('oklch(21% 0.034 264.665)')).toBe('dark');
    expect(parseLuminanceTheme('oklch(0.98 0.005 240)')).toBe('light');
    expect(parseLuminanceTheme('oklch(98% 0.005 240)')).toBe('light');
    expect(parseLuminanceTheme('oklch(0.21 0.034 264.665 / 0)')).toBeNull();
    expect(parseLuminanceTheme('oklab(0.18 0.01 -0.02)')).toBe('dark');
    expect(parseLuminanceTheme('hsl(222, 47%, 11%)')).toBe('dark');
    expect(parseLuminanceTheme('hsla(210, 40%, 98%, 1)')).toBe('light');
    expect(parseLuminanceTheme('hsla(222, 47%, 11%, 0)')).toBeNull();
    expect(parseLuminanceTheme('color(srgb 0.04 0.05 0.09)')).toBe('dark');
    expect(parseLuminanceTheme('color(display-p3 0.98 0.98 0.99)')).toBe('light');
    expect(parseLuminanceTheme('rgba(0, 0, 0, 0)')).toBeNull();
    expect(parseLuminanceTheme('rgba(15, 23, 42, 0.05)')).toBeNull();
    expect(parseLuminanceTheme('transparent')).toBeNull();
  });

  test('detectElementTheme inspects classList, data-theme attributes, colorScheme, and computed background luminance', () => {
    const mockDarkClassEl = {
      classList: { contains: (c: string) => c === 'dark' },
      getAttribute: () => null,
      style: {},
    } as unknown as Element;
    expect(detectElementTheme(mockDarkClassEl)).toBe('dark');

    const mockDataThemeEl = {
      classList: { contains: () => false },
      getAttribute: (attr: string) => (attr === 'data-theme' ? 'light' : null),
      style: {},
    } as unknown as Element;
    expect(detectElementTheme(mockDataThemeEl)).toBe('light');

    const mockBgEl = {
      classList: { contains: () => false },
      getAttribute: () => null,
      style: {},
    } as unknown as Element;
    expect(detectElementTheme(mockBgEl, { backgroundColor: 'rgb(248, 250, 252)' })).toBe('light');
  });

  test('detectParentDocumentTheme handles cross-origin SecurityError gracefully and detects same-origin parent theme', () => {
    const crossOriginWin = {
      self: {},
      top: {},
      parent: {
        get document(): any {
          throw new Error('SecurityError: Blocked a frame with origin');
        },
      },
    };
    expect(detectParentDocumentTheme(crossOriginWin)).toBeNull();

    const sameOriginWin = {
      self: {},
      top: {},
      parent: {
        document: {
          documentElement: {
            classList: { contains: (c: string) => c === 'light' },
            getAttribute: () => null,
            style: {},
          },
          body: null,
        },
        getComputedStyle: () => ({ backgroundColor: 'rgba(0, 0, 0, 0)', colorScheme: '' }),
      },
    };
    expect(detectParentDocumentTheme(sameOriginWin)).toBe('light');
  });

  test('getInitialThemeMode ignores stale localStorage when embedded in an iframe and defaults to system', () => {
    const mockStorage = {
      getItem: () => 'dark',
    };
    const embeddedWin = {
      self: { id: 1 },
      top: { id: 2 },
      location: { search: '', hash: '' },
    };
    expect(isEmbeddedIframe(embeddedWin)).toBe(true);
    expect(getInitialThemeMode(embeddedWin, mockStorage)).toBe('system');

    const standaloneWin = {
      self: { id: 1 },
      top: undefined as any,
      location: { search: '', hash: '' },
    };
    standaloneWin.top = standaloneWin.self;
    expect(isEmbeddedIframe(standaloneWin)).toBe(false);
    expect(getInitialThemeMode(standaloneWin, mockStorage)).toBe('dark');
  });

  test('resolveAutoTheme prioritizes parent document theme over matchMedia and falls back to matchMedia', () => {
    const winWithLightParent = {
      self: { id: 1 },
      top: { id: 2 },
      location: { search: '', hash: '' },
      parent: {
        document: {
          documentElement: {
            classList: { contains: () => false },
            getAttribute: (name: string) => (name === 'data-theme' ? 'light' : null),
            style: {},
          },
          body: null,
        },
        getComputedStyle: () => ({}),
      },
      matchMedia: () => ({ matches: true }), // OS is dark, but parent host is light
    };
    expect(resolveAutoTheme(winWithLightParent)).toBe('light');

    const crossOriginWinWithLightMedia = {
      self: { id: 1 },
      top: { id: 2 },
      location: { search: '', hash: '' },
      parent: {
        get document(): any {
          throw new Error('Cross-origin');
        },
      },
      matchMedia: (q: string) => ({ matches: q.includes('dark') ? false : true }),
    };
    expect(resolveAutoTheme(crossOriginWinWithLightMedia)).toBe('light');
  });

  test('ThemeContext wires MutationObserver, matchMedia, and postMessage listeners', () => {
    const fs = require('fs');
    const path = require('path');
    const contextCode = fs.readFileSync(
      path.resolve(__dirname, '../frontend/src/theme/ThemeContext.tsx'),
      'utf-8'
    );
    expect(contextCode).toContain('MutationObserver');
    expect(contextCode).toContain('prefers-color-scheme: dark');
    expect(contextCode).toContain("addEventListener('message'");
  });

  test('detectParentDocumentTheme prioritizes explicit dark classes/attributes on body, #app, or frameElement ancestors over white html background', () => {
    const htmlEl = {
      classList: { contains: () => false },
      getAttribute: () => null,
      style: {},
    };
    const bodyEl = {
      classList: { contains: (c: string) => c === 'dark' },
      getAttribute: () => null,
      style: {},
    };
    const winWithWhiteHtmlAndDarkBody = {
      self: { id: 1 },
      top: { id: 2 },
      parent: {
        document: {
          documentElement: htmlEl,
          body: bodyEl,
          querySelector: () => null,
        },
        // Even though html reports white background, body has explicit .dark class
        getComputedStyle: (el: any) =>
          el === htmlEl
            ? { backgroundColor: 'rgb(255, 255, 255)', colorScheme: 'normal' }
            : { backgroundColor: 'rgb(9, 13, 22)', colorScheme: 'dark' },
      },
    };
    expect(detectParentDocumentTheme(winWithWhiteHtmlAndDarkBody)).toBe('dark');

    // Frame container has dark background (oklch) while html has default white background
    const darkContainerEl = {
      classList: { contains: () => false },
      getAttribute: () => null,
      style: {},
      parentElement: null,
    };
    const winWithDarkFrameAncestor = {
      self: { id: 1 },
      top: { id: 2 },
      frameElement: {
        parentElement: darkContainerEl,
      },
      parent: {
        document: {
          documentElement: htmlEl,
          body: {
            classList: { contains: () => false },
            getAttribute: () => null,
            style: {},
          },
          querySelector: () => null,
        },
        getComputedStyle: (el: any) => {
          if (el === darkContainerEl) {
            return { backgroundColor: 'oklch(0.18 0.02 260)', colorScheme: '' };
          }
          return { backgroundColor: 'rgb(255, 255, 255)', colorScheme: '' };
        },
      },
    };
    expect(detectParentDocumentTheme(winWithDarkFrameAncestor)).toBe('dark');

    // Same-origin parent localStorage has dark theme token
    const winWithParentLocalStorage = {
      self: { id: 1 },
      top: { id: 2 },
      parent: {
        localStorage: {
          getItem: (key: string) => (key === 'vueuse-color-scheme' ? 'dark' : null),
        },
        document: {
          documentElement: htmlEl,
          body: null,
        },
        getComputedStyle: () => ({ backgroundColor: 'rgb(255, 255, 255)', colorScheme: '' }),
      },
    };
    expect(detectParentDocumentTheme(winWithParentLocalStorage)).toBe('dark');

    // Frame container has inherited computedStyle.colorScheme='light', while html/body has data-darkmode="true"
    const innerWrapperEl = {
      classList: { contains: () => false },
      getAttribute: () => null,
      style: {},
      parentElement: null,
    };
    const darkHtmlEl = {
      classList: { contains: () => false },
      getAttribute: (name: string) => (name === 'data-darkmode' ? 'true' : null),
      style: {},
    };
    const winWithInheritedLightColorSchemeAndDarkHtml = {
      self: { id: 1 },
      top: { id: 2 },
      frameElement: {
        parentElement: innerWrapperEl,
      },
      parent: {
        document: {
          documentElement: darkHtmlEl,
          body: null,
          querySelector: () => null,
        },
        getComputedStyle: () => ({ backgroundColor: 'rgb(255, 255, 255)', colorScheme: 'light' }),
      },
    };
    expect(detectParentDocumentTheme(winWithInheritedLightColorSchemeAndDarkHtml)).toBe('dark');
  });

  test('getInitialThemeMode ignores legacy gemini_proxy_theme cache so mobile devices are not locked to light mode', () => {
    const legacyLightStorage = {
      getItem: (key: string) => (key === 'gemini_proxy_theme' ? 'light' : null),
    };
    const standaloneWin = {
      self: { id: 1 },
      top: undefined as any,
      location: { search: '', hash: '' },
    };
    standaloneWin.top = standaloneWin.self;
    expect(getInitialThemeMode(standaloneWin, legacyLightStorage)).toBe('system');
  });

  test('index.html and index.css declare light dark color-scheme for mobile WebKit/WebView dark mode inheritance', () => {
    const fs = require('fs');
    const path = require('path');
    const indexHtml = fs.readFileSync(
      path.resolve(__dirname, '../frontend/index.html'),
      'utf-8'
    );
    const indexCss = fs.readFileSync(
      path.resolve(__dirname, '../frontend/src/index.css'),
      'utf-8'
    );
    expect(indexHtml).toMatch(/<meta\s+name="color-scheme"\s+content="light dark"\s*\/?>/i);
    expect(indexCss).toContain('color-scheme: light dark;');
  });

  test('LoginView and UnifiedTerminalView wire toggleTheme and keep Sun/Moon icons intact', () => {
    const fs = require('fs');
    const path = require('path');
    const loginCode = fs.readFileSync(
      path.resolve(__dirname, '../frontend/src/components/LoginView.tsx'),
      'utf-8'
    );
    const unifiedCode = fs.readFileSync(
      path.resolve(__dirname, '../frontend/src/components/UnifiedTerminalView.tsx'),
      'utf-8'
    );

    expect(loginCode).toContain('toggleTheme');
    expect(loginCode).toMatch(/<Sun\b|<Moon\b/);
    expect(unifiedCode).toContain('toggleTheme');
    expect(unifiedCode).toMatch(/<Sun\b|<Moon\b/);
  });
});
