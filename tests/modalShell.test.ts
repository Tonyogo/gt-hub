import * as fs from 'fs';
import * as path from 'path';
import {
  getModalShellClasses,
  shouldCloseOnModalKeyDown,
} from '../frontend/src/components/ui/ModalShell';

describe('ModalShell Portal Primitive & Accessibility', () => {
  const modalShellPath = path.resolve(__dirname, '../frontend/src/components/ui/ModalShell.tsx');

  test('getModalShellClasses returns bottom-sheet responsive modal classes for base layer', () => {
    const classes = getModalShellClasses({ variant: 'modal', zIndex: 'base' });
    expect(classes.backdropClassName).toContain('fixed inset-0');
    expect(classes.backdropClassName).toContain('z-50');
    expect(classes.backdropClassName).toContain('items-end sm:items-center');
    expect(classes.backdropClassName).toContain('backdrop-blur-xl');
    expect(classes.backdropClassName).toContain('bg-zinc-950/35');
    expect(classes.backdropClassName).toContain('dark:bg-black/60');

    expect(classes.panelClassName).toContain('ui-card');
    expect(classes.panelClassName).toContain('ui-modal-shell');
    expect(classes.panelClassName).toContain('max-h-[88dvh]');
    expect(classes.panelClassName).toContain('rounded-t-2xl sm:rounded-xl');
    expect(classes.panelClassName).toContain('flex flex-col');
    expect(classes.panelClassName).toContain('overflow-hidden');
    expect(classes.panelClassName).not.toContain('zoom-in');
    expect(classes.panelClassName).not.toContain('scale-');

    expect(classes.bodyClassName).toContain('flex-1 min-h-0 overflow-y-auto overscroll-contain');
  });

  test('getModalShellClasses supports nested z-[60], custom width, and fixed height', () => {
    const classes = getModalShellClasses({
      variant: 'modal',
      zIndex: 'nested',
      maxWidthClassName: 'max-w-5xl',
      heightClassName: 'h-[88dvh]',
    });
    expect(classes.backdropClassName).toContain('z-[60]');
    expect(classes.backdropClassName).not.toContain('z-50');
    expect(classes.panelClassName).toContain('max-w-5xl');
    expect(classes.panelClassName).toContain('h-[88dvh]');
  });

  test('getModalShellClasses configures right-aligned drawer variant', () => {
    const classes = getModalShellClasses({ variant: 'drawer', zIndex: 'base' });
    expect(classes.backdropClassName).toContain('justify-end');
    expect(classes.panelClassName).toContain('bg-[var(--bg-sidebar)]');
    expect(classes.panelClassName).toContain('h-full');
    expect(classes.panelClassName).toContain('ui-modal-shell');
  });

  test('shouldCloseOnModalKeyDown enforces Escape handling and disableClose guard', () => {
    expect(shouldCloseOnModalKeyDown('Escape', false)).toBe(true);
    expect(shouldCloseOnModalKeyDown('Escape', true)).toBe(false);
    expect(shouldCloseOnModalKeyDown('Enter', false)).toBe(false);
  });

  test('ModalShell.tsx uses document.body Portal, a11y dialog attributes, safe-area footer, and zero anti-patterns', () => {
    const src = fs.readFileSync(modalShellPath, 'utf-8');
    expect(src).toContain('createPortal(');
    expect(src).toContain('document.body');
    expect(src).toContain("typeof document === 'undefined'");
    expect(src).toContain('role="dialog"');
    expect(src).toContain('aria-modal="true"');
    expect(src).toContain('shrink-0');
    expect(src).toContain('env(safe-area-inset-bottom)');
    expect(src).not.toContain('indigo-');
    expect(src).not.toContain('slate-');
    expect(src).not.toContain('zoom-in');
  });
});
