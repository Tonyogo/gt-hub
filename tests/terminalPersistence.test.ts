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

  it('should compact and purge stale history when terminal scrollback clear sequence is received', () => {
    const mockAgentWs = { readyState: 1, send: jest.fn() };
    const session = new RemoteAgentTerminalSession('test-clear-compact-host', mockAgentWs);
    session.handleData('stale page 1\r\nstale page 2\r\n');
    expect(session.getHistory()).toContain('stale page 1');

    session.handleData('clear\r\n\x1b[3J\x1b[H\x1b[2Jcurrent clean prompt > ');
    expect(session.getHistory()).not.toContain('stale page 1');
    expect(session.getHistory()).toContain('current clean prompt > ');
  });
});
