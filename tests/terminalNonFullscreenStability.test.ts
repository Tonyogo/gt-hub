import * as fs from 'fs';
import * as path from 'path';

describe('Non-Fullscreen Terminal Stability & Continuous Canvas', () => {
  const unifiedPath = path.resolve(__dirname, '../frontend/src/components/UnifiedTerminalView.tsx');
  const webTerminalPath = path.resolve(__dirname, '../frontend/src/components/WebTerminalView.tsx');
  const agentPath = path.resolve(__dirname, '../src/agent/daemon.ts');
  const legacyGtPath = path.resolve(__dirname, '../scripts/gt.js');
  const gtPath = fs.existsSync(agentPath) ? agentPath : legacyGtPath;

  let unifiedContent: string;
  let webTerminalContent: string;
  let gtContent: string;

  beforeAll(() => {
    unifiedContent = fs.readFileSync(unifiedPath, 'utf-8');
    webTerminalContent = fs.readFileSync(webTerminalPath, 'utf-8');
    gtContent = fs.readFileSync(gtPath, 'utf-8');
  });

  it('UnifiedTerminalView enforces min-h-[420px] on non-fullscreen container to prevent height collapse', () => {
    expect(unifiedContent).toContain('min-h-[420px]');
    expect(unifiedContent).toContain('flex-1');
  });

  it('WebTerminalView canvas container does not use conditional hidden class', () => {
    // terminalContainerRef must not be conditionally set to hidden
    expect(webTerminalContent).not.toMatch(/ref=\{terminalContainerRef\}[\s\S]*?!activeHostId\s*\?\s*['"]hidden['"]/);
    expect(webTerminalContent).toMatch(/!activeHostId\s*&&[\s\S]*?absolute inset-0 z-20/);
  });

  it('sendResize only commits lastSentColsRef when WebSocket is OPEN', () => {
    expect(webTerminalContent).toMatch(/wsRef\.current\.readyState\s*===\s*WebSocket\.OPEN[\s\S]*?lastSentColsRef\.current\s*=\s*cols/);
  });

  it('ws.onopen resets lastSentColsRef to ensure fresh PTY size dispatch', () => {
    expect(webTerminalContent).toMatch(/onopen[\s\S]*?lastSentColsRef\.current\s*=\s*0/);
  });

  it('UnifiedTerminalView triggers active fit timers on subTab and activeHostId updates', () => {
    expect(unifiedContent).toMatch(/useEffect\(\(\)\s*=>\s*\{[\s\S]*?subTab\s*===\s*'interactive'[\s\S]*?terminalRef\.current\?\.fit\(\)[\s\S]*?\}\s*,\s*\[subTab,\s*activeHostId\]\)/);
  });

  it('WebTerminalView safeFit and term.write explicitly refresh visible rows to prevent blank unrendered canvas', () => {
    // safeFit must call term.refresh
    expect(webTerminalContent).toMatch(/fitAddonRef\.current\.fit\(\)[\s\S]*?term\.refresh\s*\(\s*0\s*,\s*Math\.max/);
    // term.write callback must call term.refresh
    expect(webTerminalContent).toMatch(/term\?\.write\([\s\S]*?term\?\.refresh\s*\(\s*0\s*,\s*Math\.max/);
  });

  it('WebTerminalView triggers safeFit on first data packet arrival via hasFirstDataFittedRef', () => {
    expect(webTerminalContent).toContain('hasFirstDataFittedRef');
    expect(webTerminalContent).toMatch(/!hasFirstDataFittedRef\.current/);
  });

  it('WebTerminalView skips refit scroll lock on initial standalone mount via isInitialStandaloneMountRef', () => {
    expect(webTerminalContent).toContain('isInitialStandaloneMountRef');
    expect(webTerminalContent).toMatch(/if\s*\(\s*isInitialStandaloneMountRef\.current\s*\)\s*\{\s*isInitialStandaloneMountRef\.current\s*=\s*false;\s*return;\s*\}/);
  });

  it('scripts/gt.js nudges rows by 1 when target resize matches current PTY size to force kernel SIGWINCH', () => {
    expect(gtContent).toMatch(/currentCols\s*===\s*cols\s*&&\s*currentRows\s*===\s*rows/);
    expect(gtContent).toMatch(/ptyProcess\.resize\(cols,\s*nudgeRows\)/);
  });

  it('scripts/gt.js queues early shell output before WebSocket opens and flushes on connection', () => {
    expect(gtContent).toContain('pendingOutputQueue');
    expect(gtContent).toContain('flushPendingOutput');
    expect(gtContent).toMatch(/pendingOutputQueue\.push\(buf\)/);
    expect(gtContent).toMatch(/flushPendingOutput\(\)/);
  });

  it('scripts/gt.js debounces duplicate dimension nudges to prevent resize storms', () => {
    expect(gtContent).toContain('lastNudgeTimestamp');
    expect(gtContent).toContain('nudgeRestoreTimer');
    expect(gtContent).toMatch(/!nudgeRestoreTimer\s*&&\s*\(now\s*-\s*lastNudgeTimestamp\s*>\s*1000\)/);
  });
});
