import {
  isSyntheticTerminalReport,
  isUnsolicitedShellDeviceReport,
} from '../frontend/src/utils/terminalFilter';
import {
  stripTerminalQuerySequences,
  RemoteAgentTerminalSession,
} from '../src/terminal/services/terminalHostManager';

describe('Terminal Synthetic Echo Protection (OSC 11 / DA / CPR)', () => {
  describe('isSyntheticTerminalReport with Compound Sequences', () => {
    it('detects standalone CPR, DA, and OSC 11 reports', () => {
      expect(isSyntheticTerminalReport('\x1b]11;rgb:0909/0a0a/0f0f\x1b\\')).toBe(true);
      expect(isSyntheticTerminalReport('\x1b]11;rgb:0909/0a0a/0f0f\x07')).toBe(true);
      expect(isSyntheticTerminalReport('\x1b[?1;2c')).toBe(true);
      expect(isSyntheticTerminalReport('\x1b[1;1R')).toBe(true);
    });

    it('detects the exact user bug report compound sequence (OSC 11 + DA + CPR concatenated)', () => {
      const compound = '\x1b]11;rgb:0909/0a0a/0f0f\x1b\\\x1b[?1;2c\x1b[1;1R';
      expect(isSyntheticTerminalReport(compound)).toBe(true);
    });

    it('detects arbitrary permutations and combinations of synthetic reports', () => {
      const multi =
        '\x1b]10;rgb:ffff/ffff/ffff\x07\x1b]11;rgb:0909/0a0a/0f0f\x1b\\\x1b[>0;276;0c\x1b[?1049;1$y\x1b[24;80R';
      expect(isSyntheticTerminalReport(multi)).toBe(true);
    });

    it('never flags user input or command strings containing escapes', () => {
      expect(isSyntheticTerminalReport('ls -la\r')).toBe(false);
      expect(isSyntheticTerminalReport('\x1b[A')).toBe(false); // Up arrow
      expect(isSyntheticTerminalReport('\x1b[B')).toBe(false); // Down arrow
      expect(isSyntheticTerminalReport('\x03')).toBe(false); // Ctrl+C
      expect(isSyntheticTerminalReport(':wq\r')).toBe(false);
      expect(isSyntheticTerminalReport('git commit -m "feat: 1;2c"\r')).toBe(false);
    });
  });

  describe('isUnsolicitedShellDeviceReport', () => {
    it('identifies color reports and DA reports as unsolicited for normal shell prompt', () => {
      expect(isUnsolicitedShellDeviceReport('\x1b]11;rgb:0909/0a0a/0f0f\x1b\\')).toBe(true);
      expect(isUnsolicitedShellDeviceReport('\x1b[?1;2c')).toBe(true);
      expect(isUnsolicitedShellDeviceReport('\x1b]11;rgb:0909/0a0a/0f0f\x1b\\\x1b[?1;2c')).toBe(true);
    });

    it('does not classify CPR alone as unsolicited shell device report (allowing TUI app CPR)', () => {
      expect(isUnsolicitedShellDeviceReport('\x1b[1;1R')).toBe(false);
    });

    it('does not classify regular user input as unsolicited device report', () => {
      expect(isUnsolicitedShellDeviceReport('echo hello\r')).toBe(false);
      expect(isUnsolicitedShellDeviceReport('\x1b[A')).toBe(false);
    });
  });

  describe('stripTerminalQuerySequences', () => {
    it('prepends soft style reset prefix to prevent color bleed or broken escapes from previous chunks', () => {
      const input = 'hello world';
      const output = stripTerminalQuerySequences(input);
      expect(output.startsWith('\x1b[0m\x1b[?25h')).toBe(true);
      expect(output).toContain('hello world');
    });

    it('strips OSC 10/11 color queries from replayed stream', () => {
      const input = 'prompt$ \x1b]11;?\x1b\\line2';
      expect(stripTerminalQuerySequences(input)).toBe('\x1b[0m\x1b[?25hprompt$ line2');

      const belInput = 'prompt$ \x1b]10;?\x07line2';
      expect(stripTerminalQuerySequences(belInput)).toBe('\x1b[0m\x1b[?25hprompt$ line2');
    });

    it('strips DA and CPR queries from replayed stream', () => {
      const input = 'prompt$ \x1b[c\x1b[>c\x1b[6nline2';
      expect(stripTerminalQuerySequences(input)).toBe('\x1b[0m\x1b[?25hprompt$ line2');
    });

    it('preserves visual ANSI color codes, text, and screen clear sequences', () => {
      const visualInput = '\x1b[2J\x1b[H\x1b[32muser@host\x1b[0m:\x1b[34m~/dir\x1b[0m$ ls\r\n';
      expect(stripTerminalQuerySequences(visualInput)).toBe('\x1b[0m\x1b[?25h' + visualInput);
    });

    it('handles empty or non-string inputs safely', () => {
      expect(stripTerminalQuerySequences('')).toBe('');
      expect(stripTerminalQuerySequences(null as any)).toBe('');
      expect(stripTerminalQuerySequences(undefined as any)).toBe('');
    });
  });

  describe('RemoteAgentTerminalSession History Sanitation on Attach', () => {
    it('sanitizes historical buffer before sending to attaching websocket client', () => {
      const session = new RemoteAgentTerminalSession('test-agent-query-strip');
      const received: string[] = [];
      const mockWs = {
        readyState: 1,
        send: (data: string) => received.push(data),
      };

      // Feed history with query codes embedded in prompt
      session.handleData('Welcome to Ubuntu 22.04\r\n');
      session.handleData('\x1b]11;?\x1b\\\x1b[cuser@server:~$ ');

      // Attach client
      session.attach(mockWs);

      expect(received.length).toBe(1);
      const output = received[0];

      // Verification: text is preserved
      expect(output).toContain('Welcome to Ubuntu 22.04');
      expect(output).toContain('user@server:~$ ');

      // Verification: queries are stripped
      expect(output).not.toContain('\x1b]11;?\x1b\\');
      expect(output).not.toContain('\x1b[c');

      session.detach(mockWs);
    });
  });
});
