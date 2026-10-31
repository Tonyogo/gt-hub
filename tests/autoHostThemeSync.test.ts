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
  test('parseThemeToken normalizes dark, light, and system/auto tokens and rejects invalid input', () => {
    expect(parseThemeToken('dark')).toBe('dark');
    expect(parseThemeToken('NIGHT')).toBe('dark');
    expect(parseThemeToken('light')).toBe('light');
    expect(parseThemeToken('day')).toBe('light');
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

  test('parseLuminanceTheme classifies dark/light backgrounds and ignores transparent rgba(0, 0, 0, 0)', () => {
    expect(parseLuminanceTheme('rgb(9, 13, 22)')).toBe('dark');
    expect(parseLuminanceTheme('rgb(255, 255, 255)')).toBe('light');
    expect(parseLuminanceTheme('#090d16')).toBe('dark');
    expect(parseLuminanceTheme('#f8fafc')).toBe('light');
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
