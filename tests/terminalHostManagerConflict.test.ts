import { TerminalHostManager } from '../src/terminal/services/terminalHostManager';

describe('TerminalHostManager - Conflict Check & Canonical ID Routing', () => {
  let manager: TerminalHostManager;

  beforeEach(() => {
    manager = new TerminalHostManager();
  });

  it('successfully registers first agent with unique ID and name', () => {
    const mockWs = { readyState: 1, send: jest.fn(), close: jest.fn() };
    const res = manager.registerAgent({
      hostId: 'e90f23a8b12c',
      name: 'worker-node',
      hostname: 'ubuntu-1',
      agentWs: mockWs,
    });

    expect(res.success).toBe(true);
    expect(res.host?.id).toBe('e90f23a8b12c');
    expect(res.host?.name).toBe('worker-node');
    expect(res.host?.status).toBe('online');
  });

  it('rejects second agent with same name when first agent is online', () => {
    const mockWs1 = { readyState: 1, send: jest.fn(), close: jest.fn() };
    const mockWs2 = { readyState: 1, send: jest.fn(), close: jest.fn() };

    manager.registerAgent({
      hostId: 'e90f23a8b12c',
      name: 'worker-node',
      hostname: 'ubuntu-1',
      agentWs: mockWs1,
    });

    // Attempt to register duplicate name from different host ID while first is online
    const res2 = manager.registerAgent({
      hostId: '4a1b7c89df20',
      name: 'worker-node',
      hostname: 'ubuntu-2',
      agentWs: mockWs2,
    });

    expect(res2.success).toBe(false);
    expect(res2.error).toContain("Host name 'worker-node' is already in use by active node 'e90f23a8b12c'");

    // First agent session must remain intact and online
    const firstHost = manager.getHost('e90f23a8b12c');
    expect(firstHost?.status).toBe('online');
    expect(manager.getSession('e90f23a8b12c')).not.toBeNull();
  });

  it('allows takeover of name if previous agent with that name is offline', () => {
    const mockWs1 = { readyState: 1, send: jest.fn(), close: jest.fn(), destroy: jest.fn() };
    const mockWs2 = { readyState: 1, send: jest.fn(), close: jest.fn() };

    manager.registerAgent({
      hostId: 'e90f23a8b12c',
      name: 'worker-node',
      hostname: 'ubuntu-1',
      agentWs: mockWs1,
    });

    // First agent goes offline
    manager.unregisterAgent('e90f23a8b12c');
    expect(manager.getHost('e90f23a8b12c')?.status).toBe('offline');

    // Second agent connects with same name
    const res2 = manager.registerAgent({
      hostId: '4a1b7c89df20',
      name: 'worker-node',
      hostname: 'ubuntu-1-restarted',
      agentWs: mockWs2,
    });

    expect(res2.success).toBe(true);
    expect(res2.host?.id).toBe('4a1b7c89df20');
    expect(res2.host?.status).toBe('online');

    // Old offline host record was pruned
    expect(manager.getHost('e90f23a8b12c')).toBeNull();
  });

  it('resolves canonical host ID by exact ID, short prefix, or Name', () => {
    const mockWs = { readyState: 1, send: jest.fn() };
    manager.registerAgent({
      hostId: 'e90f23a8b12c',
      name: 'production-app',
      hostname: 'prod-srv',
      agentWs: mockWs,
    });

    // 1. Exact ID
    expect(manager.resolveCanonicalHostId('e90f23a8b12c')).toBe('e90f23a8b12c');
    // 2. Short prefix (min 4 chars)
    expect(manager.resolveCanonicalHostId('e90f23')).toBe('e90f23a8b12c');
    // 3. Name lookup
    expect(manager.resolveCanonicalHostId('production-app')).toBe('e90f23a8b12c');
    // 4. Non-existent
    expect(manager.resolveCanonicalHostId('non-existent')).toBeNull();
  });
});
