import * as fs from 'fs';
import * as path from 'path';

describe('WebTerminalView Auto-Fit Initialization & Healing', () => {
  const webTerminalPath = path.resolve(__dirname, '../frontend/src/components/WebTerminalView.tsx');
  let content: string;

  beforeAll(() => {
    content = fs.readFileSync(webTerminalPath, 'utf-8');
  });

  it('implements safeFit with container dimension guards (clientWidth > 0 && clientHeight > 0)', () => {
    expect(content).toContain('safeFit');
    expect(content).toMatch(/container\.clientWidth\s*<=\s*0\s*\|\|\s*container\.clientHeight\s*<=\s*0/);
  });

  it('uses multi-stage mount probing with requestAnimationFrame and staged fallbacks', () => {
    expect(content).toContain('requestAnimationFrame');
    expect(content).toMatch(/setTimeout\([^,]+,\s*150\)/);
    expect(content).toMatch(/setTimeout\([^,]+,\s*300\)/);
  });

  it('heals layout on first data arrival if terminal dimensions are uninitialized', () => {
    expect(content).toMatch(/cols\s*<=\s*2\s*\|\|\s*[^.]*\.rows\s*<=\s*1/);
  });

  it('triggers safeFit on document.fonts.ready to handle font metric loading', () => {
    expect(content).toContain('document.fonts.ready');
  });

  it('triggers safeFit on ws.onopen with calibration fallback', () => {
    expect(content).toContain('ws.onopen');
    expect(content).toMatch(/onopen[\s\S]*?safeFit/);
  });
});
