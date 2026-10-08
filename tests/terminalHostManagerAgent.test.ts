import { terminalHostManager } from '../src/terminal/services/terminalHostManager';

describe('TerminalHostManager Agent Accessors', () => {
  it('correctly reports online status and returns agentWs by ID or name', () => {
    const mockWs = { readyState: 1, send: jest.fn() };
    const hostId = 'agent-123456';
    const hostName = 'hk-vps';

    terminalHostManager.registerHost({
      id: hostId,
      name: hostName,
      hostname: 'vps-hk-1',
      ip: '1.2.3.4',
      platform: 'linux',
      type: 'agent'
    }, mockWs);

    expect(terminalHostManager.isAgentOnline(hostId)).toBe(true);
    expect(terminalHostManager.isAgentOnline(hostName)).toBe(true);
    expect(terminalHostManager.getAgentWs(hostId)).toBe(mockWs);
    expect(terminalHostManager.getAgentWs(hostName)).toBe(mockWs);

    // Unknown node
    expect(terminalHostManager.isAgentOnline('unknown')).toBe(false);
    expect(terminalHostManager.getAgentWs('unknown')).toBeNull();

    // After unregister
    terminalHostManager.unregisterHost(hostId);
    expect(terminalHostManager.isAgentOnline(hostName)).toBe(false);
    expect(terminalHostManager.getAgentWs(hostName)).toBeNull();
  });
});
