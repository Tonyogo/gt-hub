import fs from 'fs';
import path from 'path';

describe('Terminal Mobile Touch Scroll Parity Tests', () => {
  const terminalViewPath = path.resolve(__dirname, '../frontend/src/components/WebTerminalView.tsx');
  const content = fs.readFileSync(terminalViewPath, 'utf-8');

  test('mobile touch swipe always scrolls line buffer directly without translating into arrow keys', () => {
    // Should call term.scrollLines on swipe
    expect(content).toContain('term.scrollLines(linesToScroll)');
    // Should NOT translate vertical touch swipe into arrow sequences (\x1b[A / \x1b[B)
    const touchMoveSection = content.slice(content.indexOf('const handleTouchMove'), content.indexOf('const handleTouchEnd'));
    expect(touchMoveSection).not.toContain("linesToScroll > 0 ? '\\x1b[B' : '\\x1b[A'");
    expect(touchMoveSection).not.toContain('arrowSequence');
  });
});
