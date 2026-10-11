import { RemoteAgentTerminalSession } from '../src/terminal/services/terminalHostManager';

describe('RemoteAgentTerminalSession Persistence & Replay', () => {
  it('should maintain state and buffer output across attach/detach cycles', (done) => {
    const mockAgentWs = { readyState: 1, send: jest.fn() };
    const session = new RemoteAgentTerminalSession('test-persistence-host', mockAgentWs);

    const mockWs = {
      readyState: 1,
      send: jest.fn((data: string) => {
        if (data.includes('PERSISTENCE_TEST_RECORD')) {
          session.detach(mockWs);

          // Test replay to a new client
          let replayedData = '';
          const newClient = {
            readyState: 1,
            send: (chunk: string) => {
              replayedData += chunk;
            },
          };
          session.attach(newClient);

          expect(replayedData).toContain('PERSISTENCE_TEST_RECORD');
          expect(session.getHistory()).toContain('PERSISTENCE_TEST_RECORD');
          done();
        }
      }),
    };

    session.attach(mockWs);
    // Simulate incoming data from agent
    session.handleData('echo "PERSISTENCE_TEST_RECORD"\r\n');
  });

  it('should cleanly reset session and clear buffer on reset()', () => {
    const mockAgentWs = { readyState: 1, send: jest.fn() };
    const session = new RemoteAgentTerminalSession('test-reset-host', mockAgentWs);
    session.handleData('some terminal history buffer');
    expect(session.getHistory()).toContain('some terminal history buffer');

    session.reset();
    expect(session.getHistory()).toBe('');
  });

  it('should retain history on \\x1b[3J and compact stale history when \\x1bc is received', () => {
    const mockAgentWs = { readyState: 1, send: jest.fn() };
    const session = new RemoteAgentTerminalSession('test-clear-compact-host', mockAgentWs);
    session.handleData('stale page 1\r\nstale page 2\r\n');
    expect(session.getHistory()).toContain('stale page 1');

    // CSI 3J should not purge scrollback buffer history
    session.handleData('clear\r\n\x1b[3J\x1b[H\x1b[2Jcurrent clean prompt > ');
    expect(session.getHistory()).toContain('stale page 1');
    expect(session.getHistory()).toContain('current clean prompt > ');

    // Hardware reset \x1bc should compact and purge stale history
    session.handleData('reset\r\n\x1bc\x1b[H\x1b[2Jbrand new prompt > ');
    expect(session.getHistory()).not.toContain('stale page 1');
    expect(session.getHistory()).toContain('brand new prompt > ');
  });

  it('should support up to 2MB buffer and drop oldest chunks when exceeding maxBufferSize', () => {
    const mockAgentWs = { readyState: 1, send: jest.fn() };
    const session = new RemoteAgentTerminalSession('test-2mb-host', mockAgentWs);

    // 1MB chunk 1 (previously 200KB limit would have truncated this)
    const chunk1 = 'A'.repeat(1024 * 1024);
    session.handleData(chunk1);
    expect(session.getHistory().length).toBe(1024 * 1024);

    // 0.8MB chunk 2 (total 1.8MB <= 2MB)
    const chunk2 = 'B'.repeat(800 * 1024);
    session.handleData(chunk2);
    expect(session.getHistory().length).toBe(1024 * 1024 + 800 * 1024);
    expect(session.getHistory()).toContain('A');
    expect(session.getHistory()).toContain('B');

    // 0.5MB chunk 3 (total 2.3MB > 2MB maxBufferSize)
    const chunk3 = 'C'.repeat(500 * 1024);
    session.handleData(chunk3);

    const history = session.getHistory();
    expect(history.length).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(history).toContain('B');
    expect(history).toContain('C');
  });
});
