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
      expect(taskViewContent).toMatch(/hidden sm:block|hidden sm:table/);
    });

    it('compacts stat cards on mobile to preserve vertical space', () => {
      // The 4-grid stats should be hidden on small screens: hidden sm:grid
      expect(taskViewContent).toMatch(/hidden sm:grid/);
    });
  });

  describe('Responsive Modals as Bottom Sheets', () => {
    it('implements bottom sheet positioning on CronJobModal', () => {
      expect(cronJobModalContent).toMatch(/items-end sm:items-center/);
      expect(cronJobModalContent).toMatch(/rounded-t-2xl|rounded-t-3xl/);
    });

    it('implements bottom sheet positioning on CronLogModal', () => {
      expect(cronLogModalContent).toMatch(/items-end sm:items-center/);
      expect(cronLogModalContent).toMatch(/rounded-t-2xl|rounded-t-3xl/);
    });

    it('implements bottom sheet positioning on CreateTaskModal', () => {
      expect(createTaskModalContent).toMatch(/items-end sm:items-center/);
      expect(createTaskModalContent).toMatch(/rounded-t-2xl|rounded-t-3xl/);
    });

    it('implements bottom sheet positioning on TaskLogModal', () => {
      expect(taskLogModalContent).toMatch(/items-end sm:items-center/);
      expect(taskLogModalContent).toMatch(/rounded-t-2xl|rounded-t-3xl/);
    });
  });
});
