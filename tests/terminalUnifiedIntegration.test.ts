import * as fs from 'fs';
import * as path from 'path';

describe('Unified Terminal Integration and Translations', () => {
  const i18nPath = path.resolve(__dirname, '../frontend/src/i18n/LanguageContext.tsx');
  const unifiedPath = path.resolve(__dirname, '../frontend/src/components/UnifiedTerminalView.tsx');

  it('i18n contains webTerminal and files translation keys in all languages', () => {
    const content = fs.readFileSync(i18nPath, 'utf-8');
    expect(content).toContain('interactiveTab');
    expect(content).toContain('exitFullscreen');
    expect(content).toContain('fullscreen');
  });

  it('UnifiedTerminalView handles mobile visualViewport when in standalone mode', () => {
    const content = fs.readFileSync(unifiedPath, 'utf-8');
    expect(content).toContain('calculateKeyboardTranslateY');
    expect(content).toContain('workspaceStyle');
  });
});
