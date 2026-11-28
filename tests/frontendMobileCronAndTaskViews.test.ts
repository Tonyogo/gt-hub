import * as fs from 'fs';
import * as path from 'path';

describe('Frontend Mobile Optimization for Cron & Tasks', () => {
  const cronViewPath = path.resolve(__dirname, '../frontend/src/components/terminal/TerminalCronView.tsx');
  const taskViewPath = path.resolve(__dirname, '../frontend/src/components/terminal/TerminalTaskView.tsx');
  const cronJobModalPath = path.resolve(__dirname, '../frontend/src/components/terminal/components/CronJobModal.tsx');
  const cronLogModalPath = path.resolve(__dirname, '../frontend/src/components/terminal/components/CronLogModal.tsx');
  const createTaskModalPath = path.resolve(__dirname, '../frontend/src/components/terminal/components/CreateTaskModal.tsx');
  const taskLogModalPath = path.resolve(__dirname, '../frontend/src/components/terminal/components/TaskLogModal.tsx');

  let cronViewContent: string;
  let taskViewContent: string;
  let cronJobModalContent: string;
  let cronLogModalContent: string;
  let createTaskModalContent: string;
  let taskLogModalContent: string;

  beforeAll(() => {
    cronViewContent = fs.readFileSync(cronViewPath, 'utf-8');
    taskViewContent = fs.readFileSync(taskViewPath, 'utf-8');
    cronJobModalContent = fs.readFileSync(cronJobModalPath, 'utf-8');
    cronLogModalContent = fs.readFileSync(cronLogModalPath, 'utf-8');
    createTaskModalContent = fs.readFileSync(createTaskModalPath, 'utf-8');
    taskLogModalContent = fs.readFileSync(taskLogModalPath, 'utf-8');
  });

  describe('TerminalCronView Mobile Adaptations', () => {
    it('contains dual-mode rendering with sm:hidden card list and hidden sm:block table', () => {
      expect(cronViewContent).toMatch(/sm:hidden/);
      expect(cronViewContent).toMatch(/hidden sm:block|hidden sm:table/);
    });

    it('retains all essential actions on mobile cards (run, toggle status, logs, edit, delete)', () => {
      expect(cronViewContent).toContain('handleRunNow');
      expect(cronViewContent).toContain('handleToggleStatus');
      expect(cronViewContent).toContain('setSelectedJobForLogs');
      expect(cronViewContent).toContain('setEditingJob');
      expect(cronViewContent).toContain('handleDeleteJob');
    });
  });

  describe('TerminalTaskView Mobile Adaptations', () => {
    it('contains dual-mode rendering with sm:hidden card list and hidden sm:block table', () => {
      expect(taskViewContent).toMatch(/sm:hidden/);
      expect(taskViewContent).toMatch(/hidden sm:(?:block|flex|table)/);
    });

    it('compacts stat cards on mobile to preserve vertical space', () => {
      // The 4-grid stats should be hidden on small screens: hidden sm:grid
      expect(taskViewContent).toMatch(/hidden sm:grid/);
    });

    it('enforces min-h-0 and overscroll-contain on root and workspace scroll containers', () => {
      expect(taskViewContent).toMatch(/min-h-0[^"]*bg-\[var\(--bg-canvas\)\]/);
      expect(taskViewContent).toMatch(/min-h-0\s+overflow-y-auto\s+overscroll-contain/);
    });

    it('uses independent flex-col scroll container for desktop table with min-h-[260px] fallback and sticky header', () => {
      expect(taskViewContent).toMatch(/hidden sm:flex sm:flex-col flex-1 min-h-\[260px\]/);
      expect(taskViewContent).toMatch(/flex-1 min-h-0 overflow-auto overscroll-contain/);
      expect(taskViewContent).toMatch(/<thead[^>]*sticky top-0 z-10 bg-\[var\(--bg-surface-sub\)\]/);
      expect(taskViewContent).toMatch(/shadow-\[inset_0_-1px_0_var\(--border-subtle\)\]/);
      expect(taskViewContent).not.toMatch(/hidden sm:block flex-1[^>]*overflow-hidden/);
    });

    it('prevents mobile card list from flex shrinking and preserves bottom scroll padding', () => {
      expect(taskViewContent).toMatch(/sm:hidden space-y-3 shrink-0 pb-4/);
    });
  });

  describe('Responsive Modals as Bottom Sheets', () => {
    it('implements bottom sheet positioning in shared ModalShell', () => {
      const modalShellPath = path.resolve(__dirname, '../frontend/src/components/ui/ModalShell.tsx');
      const modalShellContent = fs.readFileSync(modalShellPath, 'utf-8');
      expect(modalShellContent).toMatch(/items-end sm:items-center/);
      expect(modalShellContent).toMatch(/rounded-t-2xl/);
    });

    it('renders CronJobModal, CronLogModal, CreateTaskModal, and TaskLogModal through ModalShell', () => {
      expect(cronJobModalContent).toContain('<ModalShell');
      expect(cronLogModalContent).toContain('<ModalShell');
      expect(createTaskModalContent).toContain('<ModalShell');
      expect(taskLogModalContent).toContain('<ModalShell');
    });
  });
});
