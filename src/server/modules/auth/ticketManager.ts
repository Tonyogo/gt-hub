import crypto from 'crypto';

export interface TicketEntry {
  ticket: string;
  createdAt: number;
  expiresAt: number;
  metadata?: Record<string, any>;
}

export interface TicketManagerOptions {
  defaultTtlMs?: number;
  sweepIntervalMs?: number;
}

export class TicketManager {
  private tickets: Map<string, TicketEntry> = new Map();
  private defaultTtlMs: number;
  private timer: NodeJS.Timeout | null = null;

  constructor(options: TicketManagerOptions = {}) {
    this.defaultTtlMs = options.defaultTtlMs || 30000; // 30s default
    const sweepInterval = options.sweepIntervalMs !== undefined ? options.sweepIntervalMs : 60000;
    if (sweepInterval > 0) {
      this.timer = setInterval(() => this.sweep(), sweepInterval);
      if (typeof this.timer.unref === 'function') {
        this.timer.unref();
      }
    }
  }

  public createTicket(metadata?: Record<string, any>, ttlMs?: number): string {
    const ticket = crypto.randomBytes(24).toString('hex');
    const now = Date.now();
    const effectiveTtl = ttlMs || this.defaultTtlMs;
    this.tickets.set(ticket, {
      ticket,
      createdAt: now,
      expiresAt: now + effectiveTtl,
      metadata,
    });
    return ticket;
  }

  public consumeTicket(ticket: string): boolean {
    if (!ticket || typeof ticket !== 'string') return false;
    const entry = this.tickets.get(ticket);
    if (!entry) return false;

    // Immediately remove from map (single-use)
    this.tickets.delete(ticket);

    // Validate expiration
    if (Date.now() > entry.expiresAt) {
      return false;
    }
    return true;
  }

  public sweep(): void {
    const now = Date.now();
    for (const [ticket, entry] of this.tickets.entries()) {
      if (now > entry.expiresAt) {
        this.tickets.delete(ticket);
      }
    }
  }

  public size(): number {
    return this.tickets.size;
  }

  public reset(): void {
    this.tickets.clear();
  }

  public destroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.tickets.clear();
  }
}

export const ticketManager = new TicketManager();
export default ticketManager;
