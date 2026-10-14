import { TicketManager } from '../src/server/modules/auth/ticketManager';

describe('TicketManager', () => {
  let manager: TicketManager;

  beforeEach(() => {
    manager = new TicketManager({ sweepIntervalMs: 0 }); // disable automatic background timer in tests
  });

  afterEach(() => {
    manager.destroy();
  });

  it('generates a 48-character hex ticket and consumes it successfully once', () => {
    const ticket = manager.createTicket();
    expect(ticket).toBeDefined();
    expect(ticket.length).toBe(48);

    // First consumption succeeds
    expect(manager.consumeTicket(ticket)).toBe(true);

    // Second consumption must fail (single-use token)
    expect(manager.consumeTicket(ticket)).toBe(false);
  });

  it('rejects nonexistent or empty tickets', () => {
    expect(manager.consumeTicket('')).toBe(false);
    expect(manager.consumeTicket('non-existent-ticket')).toBe(false);
  });

  it('rejects expired tickets', () => {
    const ticket = manager.createTicket({}, 10); // 10ms TTL
    expect(ticket).toBeDefined();

    // Fast-forward time
    const originalNow = Date.now;
    try {
      Date.now = () => originalNow() + 100;
      expect(manager.consumeTicket(ticket)).toBe(false);
    } finally {
      Date.now = originalNow;
    }
  });

  it('purges expired tickets on sweep', () => {
    manager.createTicket({}, 10);
    expect(manager.size()).toBe(1);

    const originalNow = Date.now;
    try {
      Date.now = () => originalNow() + 100;
      manager.sweep();
      expect(manager.size()).toBe(0);
    } finally {
      Date.now = originalNow;
    }
  });
});
