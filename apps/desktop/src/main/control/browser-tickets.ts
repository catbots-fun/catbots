import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

type BrowserTicketDependencies = Readonly<{
  now?: () => number;
  compare?: (left: Uint8Array, right: Uint8Array) => boolean;
}>;

export class BrowserTicketStore {
  private readonly tickets = new Map<string, number>();
  private readonly now: () => number;
  private readonly compare: (left: Uint8Array, right: Uint8Array) => boolean;

  constructor(dependencies: BrowserTicketDependencies = {}) {
    this.now = dependencies.now ?? Date.now;
    this.compare = dependencies.compare ?? ((left, right) => timingSafeEqual(left, right));
  }

  issue(ttlMs: number): string {
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new Error('INVALID_BROWSER_TICKET_TTL');
    const ticket = randomBytes(32).toString('hex');
    this.tickets.set(digest(ticket).toString('hex'), this.now() + ttlMs);
    return ticket;
  }

  consume(ticket: string): boolean {
    const candidate = digest(ticket);
    const now = this.now();
    let match: string | undefined;
    for (const [stored, expiresAt] of this.tickets) {
      if (expiresAt < now) this.tickets.delete(stored);
      if (expiresAt >= now && this.compare(candidate, Buffer.from(stored, 'hex'))) match = stored;
    }
    if (match === undefined) return false;
    this.tickets.delete(match);
    return true;
  }
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}
