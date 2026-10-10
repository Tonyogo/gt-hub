import { TerminalHostManager } from '../src/server/modules/terminal/services/hostManager';

describe('Agent Version Telemetry in HostManager', () => {
  let hostManager: TerminalHostManager;

  beforeEach(() => {
    hostManager = new TerminalHostManager();
  });

  it('records agent version upon registration', () => {
    const mockWs: any = { readyState: 1, send: jest.fn(), close: jest.fn() };
    const res = hostManager.registerAgent({
      hostId: 'machine-1',
      name: 'node-worker',
      hostname: 'worker-box',
      ip: '10.0.0.1',
      platform: 'linux',
      machineId: 'machine-1',
      version: '1.2.3',
      agentWs: mockWs,
    });

    expect(res.success).toBe(true);
    expect(res.host).toBeDefined();
    expect(res.host?.version).toBe('1.2.3');

    const hosts = hostManager.getHosts();
    const stored = hosts.find(h => h.id === 'machine-1');
    expect(stored?.version).toBe('1.2.3');
  });

  it('gracefully handles registration without version', () => {
    const mockWs: any = { readyState: 1, send: jest.fn(), close: jest.fn() };
    const res = hostManager.registerAgent({
      hostId: 'machine-legacy',
      name: 'legacy-worker',
      agentWs: mockWs,
    });

    expect(res.success).toBe(true);
    expect(res.host?.version).toBeUndefined();
  });
});
