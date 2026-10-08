import fs from 'fs';
import path from 'path';
import { en } from '../frontend/src/i18n/locales/en';
import { zh } from '../frontend/src/i18n/locales/zh';

describe('Terminal File Manager Hidden Files Support', () => {
  const fileManagerPath = path.resolve(
    __dirname,
    '../frontend/src/components/terminal/TerminalFileManagerView.tsx'
  );
  const content = fs.readFileSync(fileManagerPath, 'utf-8');

  test('i18n translations include showHidden and hideHidden keys in both zh and en', () => {
    expect(zh.files).toHaveProperty('showHidden');
    expect(zh.files).toHaveProperty('hideHidden');
    expect(zh.files.showHidden).toBe('显示隐藏文件');
    expect(zh.files.hideHidden).toBe('不显示隐藏文件');

    expect(en.files).toHaveProperty('showHidden');
    expect(en.files).toHaveProperty('hideHidden');
    expect(en.files.showHidden).toBe('Show hidden files');
    expect(en.files.hideHidden).toBe('Hide hidden files');
  });

  test('TerminalFileManagerView defines showHiddenFiles state with localStorage persistence', () => {
    expect(content).toContain("localStorage.getItem('terminal_show_hidden_files') === 'true'");
    expect(content).toContain("localStorage.setItem('terminal_show_hidden_files', String(next))");
    expect(content).toContain('handleToggleHiddenFiles');
  });

  test('TerminalFileManagerView renders Eye and EyeOff toggle button in toolbar', () => {
    expect(content).toContain('<Eye className="w-3.5 h-3.5" />');
    expect(content).toContain('<EyeOff className="w-3.5 h-3.5" />');
    expect(content).toContain("t('files.showHidden'");
    expect(content).toContain("t('files.hideHidden'");
  });

  test('TerminalFileManagerView filters out dotfiles when showHiddenFiles is false', () => {
    expect(content).toContain('!showHiddenFiles');
    expect(content).toContain("!f.name.startsWith('.')");
  });

  test('TerminalFileManagerView renders hidden files with opacity-75 and muted text for distinction', () => {
    expect(content).toContain("const isHidden = item.name.startsWith('.');");
    expect(content).toContain("isHidden ? 'opacity-75' : ''");
    expect(content).toContain("isHidden ? 'text-slate-400' : 'text-slate-200'");
  });

  describe('Pure Filter Logic Simulation', () => {
    const mockFiles = [
      { name: '.git', isDirectory: true, path: '/workspace/.git' },
      { name: '.bashrc', isDirectory: false, path: '/workspace/.bashrc' },
      { name: '.env', isDirectory: false, path: '/workspace/.env' },
      { name: 'src', isDirectory: true, path: '/workspace/src' },
      { name: 'package.json', isDirectory: false, path: '/workspace/package.json' },
      { name: 'README.md', isDirectory: false, path: '/workspace/README.md' },
    ];

    function filterFiles(files: any[], showHidden: boolean, search: string) {
      let result = files;
      if (!showHidden) {
        result = result.filter((f) => !f.name.startsWith('.'));
      }
      if (!search.trim()) return result;
      const query = search.toLowerCase().trim();
      return result.filter((f) => f.name.toLowerCase().includes(query));
    }

    test('hides dotfiles by default when showHidden is false', () => {
      const visible = filterFiles(mockFiles, false, '');
      expect(visible.map((f) => f.name)).toEqual(['src', 'package.json', 'README.md']);
    });

    test('shows all files including dotfiles when showHidden is true', () => {
      const visible = filterFiles(mockFiles, true, '');
      expect(visible.map((f) => f.name)).toEqual([
        '.git',
        '.bashrc',
        '.env',
        'src',
        'package.json',
        'README.md',
      ]);
    });

    test('search query strictly respects showHidden false', () => {
      const visible = filterFiles(mockFiles, false, '.env');
      expect(visible).toHaveLength(0);
    });

    test('search query finds hidden files when showHidden is true', () => {
      const visible = filterFiles(mockFiles, true, '.env');
      expect(visible.map((f) => f.name)).toEqual(['.env']);
    });

    test('search query finds normal files regardless of showHidden state', () => {
      const hiddenFalse = filterFiles(mockFiles, false, 'package');
      expect(hiddenFalse.map((f) => f.name)).toEqual(['package.json']);

      const hiddenTrue = filterFiles(mockFiles, true, 'package');
      expect(hiddenTrue.map((f) => f.name)).toEqual(['package.json']);
    });
  });
});
