import * as fs from 'fs';
import * as path from 'path';
import {
  calculateMagnifierPosition,
  extractMagnifierSlice,
} from '../frontend/src/utils/terminalMagnifierHelper';

describe('terminalMagnifierHelper tests', () => {
  describe('calculateMagnifierPosition', () => {
    it('calculates standard position above finger when clientY is sufficiently low', () => {
      const pos = calculateMagnifierPosition(200, 300, 390);
      expect(pos.isFlippedBelow).toBe(false);
      expect(pos.y).toBe(240); // 300 - 60
      expect(pos.x).toBe(200);
    });

    it('flips position below finger when clientY is near screen top (< 95px)', () => {
      const pos = calculateMagnifierPosition(200, 60, 390);
      expect(pos.isFlippedBelow).toBe(true);
      expect(pos.y).toBe(105); // 60 + 45
      expect(pos.x).toBe(200);
    });

    it('clamps horizontal position within safe screen boundaries', () => {
      // Left edge clipping prevention
      const leftPos = calculateMagnifierPosition(30, 200, 390);
      expect(leftPos.x).toBe(90);

      // Right edge clipping prevention
      const rightPos = calculateMagnifierPosition(380, 200, 390);
      expect(rightPos.x).toBe(300); // 390 - 90
    });
  });

  describe('extractMagnifierSlice', () => {
    it('extracts center character and context slice correctly', () => {
      const line = 'git commit -m "fix bug"';
      const slice = extractMagnifierSlice(line, 4, 3);
      expect(slice.focusChar).toBe('c');
      expect(slice.textBefore).toBe('it ');
      expect(slice.textAfter).toBe('omm');
    });

    it('handles start of line gracefully', () => {
      const line = 'ls -la';
      const slice = extractMagnifierSlice(line, 0, 4);
      expect(slice.focusChar).toBe('l');
      expect(slice.textBefore).toBe('');
      expect(slice.textAfter).toBe('s -l');
    });

    it('handles empty line or out-of-range col gracefully', () => {
      const slice = extractMagnifierSlice('', 10, 4);
      expect(slice.focusChar).toBe(' ');
      expect(slice.textBefore).toBe('');
      expect(slice.textAfter).toBe('');
    });
  });
});

describe('WebTerminalView Magnifier Integration Tests', () => {
  const webTerminalPath = path.resolve(__dirname, '../frontend/src/components/WebTerminalView.tsx');
  let content: string;

  beforeAll(() => {
    content = fs.readFileSync(webTerminalPath, 'utf-8');
  });

  it('imports terminalMagnifierHelper functions in WebTerminalView', () => {
    expect(content).toContain('calculateMagnifierPosition');
    expect(content).toContain('extractMagnifierSlice');
    expect(content).toContain('../utils/terminalMagnifierHelper');
  });

  it('WebTerminalView contains magnifier state and touch handlers integration', () => {
    expect(content).toContain('const [magnifier, setMagnifier] = useState');
    expect(content).toContain('handleOverlayTouchStart');
    expect(content).toContain('handleOverlayTouchMove');
    expect(content).toContain('handleOverlayTouchEnd');
  });

  it('renders magnifier bubble with pointer-events-none and inverted pointer support', () => {
    expect(content).toContain('magnifier.visible');
    expect(content).toContain('pointer-events-none');
    expect(content).toContain('magnifier.isFlippedBelow');
    expect(content).toContain('magnifier.focusChar');
  });
});
