import * as fs from 'fs';
import * as path from 'path';
import { shouldAcceptTaskLogResponse } from '../frontend/src/components/terminal/components/TaskLogModal';

describe('P0 Frontend Lifecycle & Memory Leak Fixes', () => {
  const webTerminalPath = path.resolve(__dirname, '../frontend/src/components/WebTerminalView.tsx');
  const taskLogModalPath = path.resolve(
    __dirname,
    '../frontend/src/components/terminal/components/TaskLogModal.tsx'
  );
  const terminalTaskViewPath = path.resolve(
    __dirname,
    '../frontend/src/components/terminal/TerminalTaskView.tsx'
  );

  let webTerminalContent: string;
  let taskLogModalContent: string;
  let terminalTaskViewContent: string;

  beforeAll(() => {
    webTerminalContent = fs.readFileSync(webTerminalPath, 'utf-8');
    taskLogModalContent = fs.readFileSync(taskLogModalPath, 'utf-8');
    terminalTaskViewContent = fs.readFileSync(terminalTaskViewPath, 'utf-8');
  });

  describe('WebTerminalView React 18 StrictMode isMountedRef reset', () => {
    it('resets isMountedRef.current = true at the start of xterm init effect', () => {
      // Find the main useEffect for xterm initialization
      const xtermEffectIndex = webTerminalContent.indexOf('// Initialize xterm instance');
      expect(xtermEffectIndex).toBeGreaterThan(-1);

      const effectSnippet = webTerminalContent.slice(xtermEffectIndex, xtermEffectIndex + 1000);
      expect(effectSnippet).toContain('if (!terminalContainerRef.current) return;');
      expect(effectSnippet).toContain('isMountedRef.current = true;');
      // Verify isMountedRef.current = true appears before new Terminal
      const resetIndex = effectSnippet.indexOf('isMountedRef.current = true;');
      const newTermIndex = effectSnippet.indexOf('new Terminal(');
      expect(resetIndex).toBeGreaterThan(-1);
      expect(newTermIndex).toBeGreaterThan(-1);
      expect(resetIndex).toBeLessThan(newTermIndex);
    });
  });

  describe('TaskLogModal Review Focus #5: shouldAcceptTaskLogResponse in-flight response gating', () => {
    it('returns true when modal is open, requestSeq matches currentSeq, and taskIds match', () => {
      expect(
        shouldAcceptTaskLogResponse({
          isOpen: true,
          currentSeq: 3,
          requestSeq: 3,
          activeTaskId: 'task-123',
          requestTaskId: 'task-123',
        })
      ).toBe(true);
    });

    it('returns false when modal has been closed (isOpen === false)', () => {
      expect(
        shouldAcceptTaskLogResponse({
          isOpen: false,
          currentSeq: 3,
          requestSeq: 3,
          activeTaskId: 'task-123',
          requestTaskId: 'task-123',
        })
      ).toBe(false);
    });

    it('returns false when requestSeq is stale (modal was reopened or sequence advanced)', () => {
      expect(
        shouldAcceptTaskLogResponse({
          isOpen: true,
          currentSeq: 4,
          requestSeq: 3,
          activeTaskId: 'task-123',
          requestTaskId: 'task-123',
        })
      ).toBe(false);
    });

    it('returns false when activeTaskId no longer matches requestTaskId (task switched)', () => {
      expect(
        shouldAcceptTaskLogResponse({
          isOpen: true,
          currentSeq: 3,
          requestSeq: 3,
          activeTaskId: 'task-456',
          requestTaskId: 'task-123',
        })
      ).toBe(false);
    });
  });

  describe('TaskLogModal polling lifecycle and duplicate kill prevention', () => {
    it('declares isOpenRef, requestSeqRef, abortControllerRef, and logTextRef', () => {
      expect(taskLogModalContent).toContain('isOpenRef');
      expect(taskLogModalContent).toContain('requestSeqRef');
      expect(taskLogModalContent).toContain('abortControllerRef');
      expect(taskLogModalContent).toContain('logTextRef');
    });

    it('removes logText from fetchLogChunk dependencies to prevent recreating callback on every log append', () => {
      // Find useCallback definition for fetchLogChunk
      const match = taskLogModalContent.match(/const fetchLogChunk\s*=\s*useCallback\([\s\S]*?,\s*\[([\s\S]*?)\]\s*\);/);
      expect(match).toBeTruthy();
      const deps = match![1];
      expect(deps).not.toContain('logText');
    });

    it('aborts in-flight request and bumps requestSeqRef in cleanup/reset', () => {
      expect(taskLogModalContent).toMatch(/abortControllerRef\.current\??\.abort\(\)/);
      expect(taskLogModalContent).toMatch(/requestSeqRef\.current\s*\+=\s*1|requestSeqRef\.current\+\+/);
    });

    it('guards against rapid reopen stuck logs and finally state clobber via activeFetchIdRef and isManualRefresh supersede', () => {
      expect(taskLogModalContent).toContain('activeFetchIdRef');
      // Verify manual refresh supersedes polling lock
      expect(taskLogModalContent).toMatch(/isPollingRef\.current\s*&&\s*!isManualRefresh/);
      // Verify fetchId tracking
      expect(taskLogModalContent).toMatch(/const\s+fetchId\s*=\s*(?:\+\+activeFetchIdRef\.current|activeFetchIdRef\.current\s*\+\s*1)/);
      // Verify finally guard
      expect(taskLogModalContent).toMatch(/if\s*\(activeFetchIdRef\.current\s*===\s*fetchId\)\s*\{\s*isPollingRef\.current\s*=\s*false;\s*setIsLoading\(false\);/);
      // Verify cleanup/reset resets isPollingRef.current or bumps activeFetchIdRef
      expect(taskLogModalContent).toMatch(/isPollingRef\.current\s*=\s*false/);
    });

    it('delegates kill action exclusively to onKillTask without secondary apiFetch', () => {
      // In TaskLogModal.tsx handleKill, if onKillTask is provided, it must not call apiFetch(.../kill)
      const killFunctionMatch = taskLogModalContent.match(/const handleKill\s*=\s*async\s*\(\)\s*=>\s*\{([\s\S]*?)\n\s*\};/);
      expect(killFunctionMatch).toBeTruthy();
      const killBody = killFunctionMatch![1];

      // Must branch on onKillTask
      expect(killBody).toContain('if (onKillTask)');
      expect(killBody).toMatch(/await\s+onKillTask\s*\(/);
      // In the onKillTask branch, there should not be a duplicate apiFetch
      const onKillBranchMatch = killBody.match(/if\s*\(onKillTask\)\s*\{([\s\S]*?)\}\s*else/);
      expect(onKillBranchMatch).toBeTruthy();
      expect(onKillBranchMatch![1]).not.toContain('apiFetch');
    });
  });

  describe('TerminalTaskView handleKillTask signature and return type', () => {
    it('returns Promise<boolean> indicating kill success or failure', () => {
      expect(terminalTaskViewContent).toMatch(/const\s+handleKillTask\s*=\s*async\s*\([^)]*\)\s*:\s*Promise<boolean>\s*=>/);
      expect(terminalTaskViewContent).toMatch(/return\s+true;/);
      expect(terminalTaskViewContent).toMatch(/return\s+false;/);
    });

    it('passes result of handleKillTask in onKillTask prop to TaskLogModal', () => {
      const modalUsage = terminalTaskViewContent.slice(
        terminalTaskViewContent.indexOf('<TaskLogModal'),
        terminalTaskViewContent.indexOf('/>', terminalTaskViewContent.indexOf('<TaskLogModal'))
      );
      expect(modalUsage).toContain('onKillTask=');
      expect(modalUsage).toMatch(/return\s+handleKillTask|return\s+await\s+handleKillTask|handleKillTask\(taskId\)/);
    });
  });
});
