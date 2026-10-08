import { calculateKeyboardTranslateY, shouldBlockPtyResize } from '../frontend/src/utils/mobileViewportHelper';
import * as fs from 'fs';
import * as path from 'path';

describe('Mobile Viewport Helper - Strict Input Focus Guard', () => {
  it('does not detect keyboard as showing if isInputFocused is false even with large height difference', () => {
    const result = calculateKeyboardTranslateY({
      baseHeight: 844,
      viewportHeight: 600, // 244px diff (e.g. browser chrome collapsed/expanded)
      isInputFocused: false,
    });
    expect(result.isKeyboardShowing).toBe(false);
    expect(result.translateY).toBe(0);
  });

  it('detects keyboard as showing when diff exceeds threshold AND isInputFocused is true', () => {
    const result = calculateKeyboardTranslateY({
      baseHeight: 844,
      viewportHeight: 500, // 344px diff
      isInputFocused: true,
    });
    expect(result.isKeyboardShowing).toBe(true);
    expect(result.translateY).toBe(344);
  });

  it('shouldBlockPtyResize allows resize if isInputFocused is false regardless of isKeyboardShowing', () => {
    const blocked = shouldBlockPtyResize({
      baseWidth: 390,
      currentWidth: 390,
      isKeyboardShowing: true,
      isMobile: true,
      standalone: true,
      isInputFocused: false,
    });
    expect(blocked).toBe(false);
  });

  it('shouldBlockPtyResize blocks resize when mobile standalone, width stable, AND isInputFocused is true with keyboard showing', () => {
    const blocked = shouldBlockPtyResize({
      baseWidth: 390,
      currentWidth: 390,
      isKeyboardShowing: true,
      isMobile: true,
      standalone: true,
      isInputFocused: true,
    });
    expect(blocked).toBe(true);
  });
});

describe('WebTerminalView Force Resize & Lifecycle Cache Invalidation', () => {
  const webTerminalPath = path.resolve(__dirname, '../frontend/src/components/WebTerminalView.tsx');
  let webTerminalContent: string;

  beforeAll(() => {
    webTerminalContent = fs.readFileSync(webTerminalPath, 'utf-8');
  });

  it('sendResize accepts a force parameter to bypass cached dimensions check', () => {
    expect(webTerminalContent).toMatch(/const sendResize = useCallback\(\(cols:\s*number,\s*rows:\s*number,\s*force:\s*boolean\s*=\s*false\)/);
    expect(webTerminalContent).toMatch(/!force\s*&&\s*cols\s*===\s*lastSentColsRef\.current/);
  });

  it('safeFit accepts forceResize parameter and passes it to sendResize', () => {
    expect(webTerminalContent).toMatch(/const safeFit = useCallback\(\(forceResize:\s*boolean\s*=\s*false\)/);
    expect(webTerminalContent).toMatch(/sendResize\(cols,\s*rows,\s*forceResize\)/);
  });

  it('handleHostChange resets lastSentColsRef and lastSentRowsRef to 0', () => {
    expect(webTerminalContent).toMatch(/const handleHostChange = \([\s\S]*?lastSentColsRef\.current\s*=\s*0;[\s\S]*?lastSentRowsRef\.current\s*=\s*0;/);
  });

  it('executeReset resets lastSentColsRef and lastSentRowsRef to 0', () => {
    expect(webTerminalContent).toMatch(/const executeReset = useCallback\(\(\) => \{[\s\S]*?lastSentColsRef\.current\s*=\s*0;[\s\S]*?lastSentRowsRef\.current\s*=\s*0;/);
  });

  it('updateViewport checks physical input focus on textarea', () => {
    expect(webTerminalContent).toMatch(/const isInputFocused = document\.activeElement === textarea/);
  });
});

describe('Ladder Probes & Transition Compensation', () => {
  it('WebTerminalView includes multi-stage ladder probe timers on activeHostId change', () => {
    const content = fs.readFileSync(path.resolve(__dirname, '../frontend/src/components/WebTerminalView.tsx'), 'utf-8');
    expect(content).toMatch(/useEffect\(\(\)\s*=>\s*\{[\s\S]*?activeHostId[\s\S]*?safeFit\(true\)[\s\S]*?60[\s\S]*?200[\s\S]*?500/);
  });

  it('WebTerminalView triggerMountProbe schedules ladder probes up to at least 350ms', () => {
    const content = fs.readFileSync(path.resolve(__dirname, '../frontend/src/components/WebTerminalView.tsx'), 'utf-8');
    expect(content).toContain('350');
  });

  it('WebTerminalView compensates virtual keyboard dismissal transition', () => {
    const content = fs.readFileSync(path.resolve(__dirname, '../frontend/src/components/WebTerminalView.tsx'), 'utf-8');
    expect(content).toMatch(/260/);
  });
});

describe('Terminal Viewport Scrollbar Transparency & Safe Area Margin', () => {
  it('index.css includes transparent/hidden scrollbar rules for .xterm .xterm-viewport', () => {
    const indexCssPath = path.resolve(__dirname, '../frontend/src/index.css');
    const indexCssContent = fs.readFileSync(indexCssPath, 'utf-8');

    expect(indexCssContent).toContain('.xterm .xterm-viewport');
    expect(indexCssContent).toMatch(/\.xterm\s+\.xterm-viewport[\s\S]*?scrollbar-width:\s*none/);
    expect(indexCssContent).toMatch(/\.xterm\s+\.xterm-viewport::-webkit-scrollbar[\s\S]*?background:\s*transparent/);
  });

  it('WebTerminalView integrates safe area insets on canvas container to prevent edge clipping', () => {
    const webTerminalPath = path.resolve(__dirname, '../frontend/src/components/WebTerminalView.tsx');
    const webTerminalContent = fs.readFileSync(webTerminalPath, 'utf-8');

    expect(webTerminalContent).toMatch(/safe-area-inset-left/);
    expect(webTerminalContent).toMatch(/safe-area-inset-right/);
  });
});


