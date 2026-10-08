import { TerminalHostManager, RemoteAgentTerminalSession } from '../src/terminal/services/terminalHostManager';

describe('TerminalHostManager (Pure Dynamic Agent)', () => {
  let manager: TerminalHostManager;

  beforeEach(() => {
    manager = new TerminalHostManager();
  });

  test('initializes with empty hosts list', () => {
    const hosts = manager.getHosts();
    expect(hosts).toEqual([]);
    expect(manager.getSession('local')).toBeNull();
    expect(manager.getSession('non-existent')).toBeNull();
  });

  test('registers and unregisters remote agent correctly', () => {
    const mockWs = { readyState: 1, send: jest.fn() };
    const res = manager.registerAgent({
      hostId: 'agent-1',
      name: 'Test-Node',
      hostname: 'test-node',
      ip: '192.168.1.50',
      platform: 'linux',
      agentWs: mockWs,
    });
    const host = res.host!;

    expect(host.id).toBe('agent-1');
    expect(host.status).toBe('online');
    expect(manager.getHosts().length).toBe(1);

    const session = manager.getSession('agent-1');
    expect(session).toBeInstanceOf(RemoteAgentTerminalSession);

    // RemoteAgentTerminalSession write and resize
    session?.write('ls -la\n');
    expect(mockWs.send).toHaveBeenCalledWith('ls -la\n');

    session?.resize(100, 30);
    expect(mockWs.send).toHaveBeenCalledWith('JSON:{"type":"resize","cols":100,"rows":30}');

    manager.unregisterAgent('agent-1');
    expect(manager.getHost('agent-1')?.status).toBe('offline');
    expect(manager.getSession('agent-1')).toBeNull();
  });

  test('relays agent data to attached client websockets and records buffer history', () => {
    const mockAgentWs = {
      readyState: 1,
      send: jest.fn(),
      on: jest.fn(),
    };

    manager.registerAgent({
      hostId: 'agent-02',
      agentWs: mockAgentWs,
    });

    const session = manager.getSession('agent-02');
    const mockClientWs = {
      readyState: 1,
      send: jest.fn(),
    };

    session?.attach(mockClientWs);

    // Incoming output from agent
    manager.handleAgentData('agent-02', 'terminal-prompt $ ');
    expect(mockClientWs.send).toHaveBeenCalledWith('terminal-prompt $ ');

    // Detach client
    session?.detach(mockClientWs);
    manager.handleAgentData('agent-02', 'new line');
    expect(mockClientWs.send).not.toHaveBeenCalledWith('new line');
  });

  it('automatically prunes stale offline node with matching name on registerAgent', () => {
    const mockAgentWs = { readyState: 1, send: jest.fn() };
    manager.registerAgent({
      hostId: 'node-old-id',
      name: 'production-app',
      agentWs: mockAgentWs,
    });
    manager.unregisterAgent('node-old-id');
    expect(manager.getHost('node-old-id')?.status).toBe('offline');

    // Reconnect with new hostId but same name
    manager.registerAgent({
      hostId: 'node-new-id',
      name: 'production-app',
      agentWs: mockAgentWs,
    });

    // Old offline node must be pruned
    expect(manager.getHost('node-old-id')).toBeNull();
    const current = manager.getHost('node-new-id');
    expect(current).not.toBeNull();
    expect(current?.status).toBe('online');

    const hosts = manager.getHosts();
    const matching = hosts.filter((h) => h.name === 'production-app');
    expect(matching).toHaveLength(1);
    expect(matching[0].id).toBe('node-new-id');
  });

  it('getHosts deduplicates same-name entries favoring online hosts', () => {
    // Force insert duplicate name entries in manager
    (manager as any).hosts.set('id-1', {
      id: 'id-1',
      name: 'duplicate-service',
      hostname: 'host-1',
      ip: '10.0.0.1',
      platform: 'linux',
      status: 'offline',
      lastSeen: 1000,
      type: 'agent',
    });
    (manager as any).hosts.set('id-2', {
      id: 'id-2',
      name: 'duplicate-service',
      hostname: 'host-2',
      ip: '10.0.0.2',
      platform: 'linux',
      status: 'online',
      lastSeen: 2000,
      type: 'agent',
    });

    const hosts = manager.getHosts();
    const serviceHosts = hosts.filter((h) => h.name === 'duplicate-service');
    expect(serviceHosts).toHaveLength(1);
    expect(serviceHosts[0].id).toBe('id-2');
    expect(serviceHosts[0].status).toBe('online');
  });
});
