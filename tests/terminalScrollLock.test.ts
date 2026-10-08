import fs from 'fs';
import path from 'path';
import {
  isUserAtBottom,
  shouldScrollToBottom,
  scrollToBottomSafe,
} from '../frontend/src/utils/terminalScrollHelper';

describe('Terminal Scroll Lock & Sticky Follow Tests', () => {
  const terminalViewPath = path.join(__dirname, '../frontend/src/components/WebTerminalView.tsx');
  const terminalViewContent = fs.readFileSync(terminalViewPath, 'utf8');

  test('isUserAtBottom respects tolerance threshold', () => {
    const term = {
      buffer: {
        active: {
          viewportY: 198,
          baseY: 200,
          type: 'normal',
        },
      },
    };

    expect(isUserAtBottom(term, 2)).toBe(true);
    expect(isUserAtBottom(term, 1)).toBe(false);
  });

  test('shouldScrollToBottom returns false when user has scrolled up', () => {
    expect(
      shouldScrollToBottom({
        isReplaying: false,
        wasAtBottom: false,
        bufferType: 'normal',
      })
    ).toBe(false);
  });

  test('WebTerminalView does not unconditionally scroll in replayTimerRef timeout', () => {
    // Ensure unconditional scrollToBottomSafe inside the 150ms timeout was removed or guarded
    const lines = terminalViewContent.split('\n');
    const timerIndices = lines.reduce<number[]>((acc, line, idx) => {
      if (line.includes('replayTimerRef.current = setTimeout')) {
        acc.push(idx);
      }
      return acc;
    }, []);

    expect(timerIndices.length).toBeGreaterThan(0);
    // Inside the 150ms timeout block, scrollToBottomSafe must be guarded by shouldScrollToBottom
    for (const idx of timerIndices) {
      const block = lines.slice(idx, idx + 10).join('\n');
      if (block.includes('150')) {
        expect(block).not.toMatch(/isReplayingRef\.current = false;\s*scrollToBottomSafe\(xtermRef\.current\);/);
      }
    }
  });

  test('WebTerminalView subscribes to term.onScroll to manage bottom tracking', () => {
    expect(terminalViewContent).toContain('term.onScroll');
    expect(terminalViewContent).toContain('setIsAtBottom');
  });

  test('WebTerminalView contains floating scroll to bottom button', () => {
    expect(terminalViewContent).toContain('handleScrollToBottom');
    expect(terminalViewContent).toContain('webTerminal.scrollToBottom');
    expect(terminalViewContent).toContain('ArrowDown');
  });
});
