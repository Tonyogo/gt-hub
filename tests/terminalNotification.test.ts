import * as fs from 'fs';
import * as path from 'path';
import {
  parseOsc9Notification,
  parseOsc777Notification,
  parseOsc99Notification,
  TerminalBellCoordinator,
  TerminalTaskCompletionDetector,
  sendUnifiedNotification,
  DEFAULT_NOTIFY_API_URL,
} from '../frontend/src/utils/terminalNotificationHelper';
import { stripTerminalQuerySequences } from '../src/shared/utils/terminalSanitizer';

describe('Universal Terminal Notification (OSC 9 / 777 / 99 / Bell)', () => {
  describe('OSC 9 (iTerm2) parser', () => {
    it('parses standard OSC 9 notification payload', () => {
      const res = parseOsc9Notification('Claude needs your permission to run Bash');
      expect(res).toEqual({
        title: '',
        body: 'Claude needs your permission to run Bash',
      });
    });

    it('ignores ConEmu progress bar sequences (OSC 9;4;...)', () => {
      expect(parseOsc9Notification('4;1;50')).toBeNull();
      expect(parseOsc9Notification('4;0')).toBeNull();
    });

    it('ignores empty or whitespace-only OSC 9 payloads', () => {
      expect(parseOsc9Notification('')).toBeNull();
      expect(parseOsc9Notification('   ')).toBeNull();
    });
  });

  describe('OSC 777 (rxvt / WezTerm / Ghostty) parser', () => {
    it('parses notify;title;body format', () => {
      const res = parseOsc777Notification('notify;Claude Code;Task completed successfully');
      expect(res).toEqual({
        title: 'Claude Code',
        body: 'Task completed successfully',
      });
    });

    it('preserves semicolons inside body text', () => {
      const res = parseOsc777Notification('notify;Alert;Step 1: ok; Step 2: done');
      expect(res).toEqual({
        title: 'Alert',
        body: 'Step 1: ok; Step 2: done',
      });
    });

    it('ignores non-notify subcommands or empty bodies', () => {
      expect(parseOsc777Notification('other;title;body')).toBeNull();
      expect(parseOsc777Notification('notify;title;   ')).toBeNull();
    });
  });

  describe('OSC 99 (Kitty) parser', () => {
    it('parses Kitty notification payload with metadata prefix', () => {
      const res = parseOsc99Notification('i=1:d=0;Build finished');
      expect(res).toEqual({
        title: '',
        body: 'Build finished',
      });
    });

    it('ignores empty Kitty notification payload', () => {
      expect(parseOsc99Notification('i=1:d=0;')).toBeNull();
    });
  });

  describe('TerminalBellCoordinator (OSC + Bell deduplication & cooldown)', () => {
    it('suppresses companion BEL within 500ms after an OSC notification', () => {
      const coord = new TerminalBellCoordinator(500, 3000);
      coord.recordOscNotification(1000);

      expect(coord.shouldTriggerBell(1200)).toBe(false);
      expect(coord.shouldTriggerBell(1499)).toBe(false);
    });

    it('triggers standalone BEL and enforces cooldown between consecutive bells', () => {
      const coord = new TerminalBellCoordinator(500, 3000);
      expect(coord.shouldTriggerBell(2000)).toBe(true);
      // Within 3000ms cooldown -> suppressed
      expect(coord.shouldTriggerBell(3500)).toBe(false);
      // After 3000ms cooldown -> allowed
      expect(coord.shouldTriggerBell(5001)).toBe(true);
    });
  });

  describe('TerminalTaskCompletionDetector (Activity-to-Idle Completion)', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('does not trigger completion for short commands (< 10s)', () => {
      const onComplete = jest.fn();
      const detector = new TerminalTaskCompletionDetector({
        minTaskDurationMs: 10000,
        idleSettleMs: 3000,
        onComplete,
      });

      detector.recordUserInput('ls -la\r', 1000);
      detector.recordOutput('total 0\r\n', 1200);
      jest.advanceTimersByTime(3500);

      expect(onComplete).not.toHaveBeenCalled();
      detector.dispose();
    });

    it('triggers completion once when a task runs >= 10s and then settles for 3s', () => {
      const onComplete = jest.fn();
      const detector = new TerminalTaskCompletionDetector({
        minTaskDurationMs: 10000,
        idleSettleMs: 3000,
        onComplete,
      });

      detector.recordUserInput('claude prompt\r', 1000);
      detector.recordOutput('Thinking...', 5000);
      detector.recordOutput('Done writing code.\r\n', 12500); // 11.5s elapsed >= 10s

      jest.advanceTimersByTime(2900);
      expect(onComplete).not.toHaveBeenCalled();

      jest.advanceTimersByTime(200);
      expect(onComplete).toHaveBeenCalledTimes(1);
      expect(onComplete).toHaveBeenCalledWith({ durationMs: 11500 });
      detector.dispose();
    });

    it('suppresses idle completion notification if an explicit OSC notification already fired during the task', () => {
      const onComplete = jest.fn();
      const detector = new TerminalTaskCompletionDetector({
        minTaskDurationMs: 10000,
        idleSettleMs: 3000,
        onComplete,
      });

      detector.recordUserInput('claude\r', 1000);
      detector.recordOutput('Working...', 12000);
      detector.recordOscNotification();

      jest.advanceTimersByTime(4000);
      expect(onComplete).not.toHaveBeenCalled();
      detector.dispose();
    });

    it('cancels task tracking when user presses Ctrl+C (\\x03)', () => {
      const onComplete = jest.fn();
      const detector = new TerminalTaskCompletionDetector({
        minTaskDurationMs: 10000,
        idleSettleMs: 3000,
        onComplete,
      });

      detector.recordUserInput('sleep 30\r', 1000);
      detector.recordOutput('running...', 12000);
      detector.recordUserInput('\x03', 12100);

      jest.advanceTimersByTime(4000);
      expect(onComplete).not.toHaveBeenCalled();
      detector.dispose();
    });
  });

  describe('sendUnifiedNotification', () => {
    beforeEach(() => {
      (global as any).fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ success: true }),
      });
    });

    afterEach(() => {
      delete (global as any).fetch;
    });

    it('sends POST request to https://www.yatao.cc.cd/api/admin/notify with x-admin-key and body', async () => {
      const res = await sendUnifiedNotification({
        adminKey: 'test-admin-key',
        type: 'warning',
        title: '[host-1] Claude Code',
        message: 'Claude needs your permission to run Bash',
      });

      expect(res).toBe(true);
      expect(global.fetch).toHaveBeenCalledTimes(1);
      const [url, opts] = (global.fetch as jest.Mock).mock.calls[0];
      expect(url).toBe(DEFAULT_NOTIFY_API_URL);
      expect(url).toBe('https://www.yatao.cc.cd/api/admin/notify');
      expect(opts.method).toBe('POST');
      expect(opts.headers['x-admin-key']).toBe('test-admin-key');
      expect(opts.headers['Content-Type']).toBe('application/json');
      expect(JSON.parse(opts.body)).toEqual({
        type: 'warning',
        title: '[host-1] Claude Code',
        message: 'Claude needs your permission to run Bash',
      });
    });

    it('handles network failure gracefully without throwing', async () => {
      (global as any).fetch = jest.fn().mockRejectedValue(new Error('Network error'));
      const res = await sendUnifiedNotification({
        adminKey: 'key',
        title: 'Title',
        message: 'Message',
      });
      expect(res).toBe(false);
    });

    it('returns false when response is not ok', async () => {
      (global as any).fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 500,
      });
      const res = await sendUnifiedNotification({
        adminKey: 'key',
        title: 'Title',
        message: 'Message',
      });
      expect(res).toBe(false);
    });
  });

  describe('Historical Scrollback Sanitizer', () => {
    it('strips OSC 9, OSC 777, OSC 99, and standalone BEL from replayed history', () => {
      const raw =
        'Starting build...\r\n' +
        '\x1b]9;Claude waiting for input\x07' +
        '\x1b]777;notify;Claude;Done\x1b\\' +
        '\x1b]99;i=1;Hello\x07' +
        'Build complete!\x07\r\n';
      const cleaned = stripTerminalQuerySequences(raw);
      expect(cleaned).toContain('Starting build...');
      expect(cleaned).toContain('Build complete!');
      expect(cleaned).not.toContain('Claude waiting for input');
      expect(cleaned).not.toContain('777;notify');
      expect(cleaned).not.toContain('99;i=1');
      expect(cleaned).not.toContain('\x07');
    });
  });

  describe('Agent PTY & Frontend Integration', () => {
    it('sets LC_TERMINAL=iTerm2 and TERM_PROGRAM=ghostty in Agent PTY environments so CLI tools emit OSC 9 and OSC 777 out of the box', () => {
      const daemonContent = fs.readFileSync(
        path.resolve(__dirname, '../src/agent/daemon.ts'),
        'utf-8'
      );
      const panePtyContent = fs.readFileSync(
        path.resolve(__dirname, '../src/agent/pty/panePtyManager.ts'),
        'utf-8'
      );
      expect(daemonContent).toContain("LC_TERMINAL: 'iTerm2'");
      expect(panePtyContent).toContain("LC_TERMINAL: 'iTerm2'");
      expect(daemonContent).toContain("TERM_PROGRAM: 'ghostty'");
      expect(panePtyContent).toContain("TERM_PROGRAM: 'ghostty'");
    });

    it('registers OSC 9, 777, 99 and onBell handlers in WebTerminalView', () => {
      const webTerminalContent = fs.readFileSync(
        path.resolve(__dirname, '../frontend/src/components/WebTerminalView.tsx'),
        'utf-8'
      );
      expect(webTerminalContent).toContain('registerOscHandler(9,');
      expect(webTerminalContent).toContain('registerOscHandler(777,');
      expect(webTerminalContent).toContain('registerOscHandler(99,');
      expect(webTerminalContent).toContain('term.onBell(');
    });

    it('dispatches notifications to external notify API and does not render toast or bell toggle button in WebTerminal / UnifiedTerminal', () => {
      const webTerminalContent = fs.readFileSync(
        path.resolve(__dirname, '../frontend/src/components/WebTerminalView.tsx'),
        'utf-8'
      );
      const unifiedContent = fs.readFileSync(
        path.resolve(__dirname, '../frontend/src/components/UnifiedTerminalView.tsx'),
        'utf-8'
      );

      expect(webTerminalContent).toContain('sendUnifiedNotification(');
      expect(webTerminalContent).not.toContain('terminalToastNotification');
      expect(webTerminalContent).not.toContain('toggle-terminal-notifications-btn');
      expect(unifiedContent).not.toContain('unified-toggle-notifications-btn');
    });
  });
});
