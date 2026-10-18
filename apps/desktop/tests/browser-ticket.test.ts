import { describe, expect, it, vi } from 'vitest';
import { BrowserTicketStore } from '../src/main/control/browser-tickets';
import { startWebServer } from '../src/main/web/http-server';

describe('BrowserTicketStore', () => {
  it('issues random tickets that can be consumed only once', () => {
    const store = new BrowserTicketStore();
    const first = store.issue(30_000);
    const second = store.issue(30_000);

    expect(first).not.toBe(second);
    expect(store.consume(first)).toBe(true);
    expect(store.consume(first)).toBe(false);
    expect(store.consume(second)).toBe(true);
  });

  it('rejects expired and malformed tickets', () => {
    let now = 1_000;
    const compare = vi.fn((left: Uint8Array, right: Uint8Array) => Buffer.from(left).equals(Buffer.from(right)));
    const store = new BrowserTicketStore({ now: () => now, compare });
    const ticket = store.issue(50);

    expect(store.consume('not-a-ticket')).toBe(false);
    expect(compare).toHaveBeenCalled();
    now = 1_051;
    expect(store.consume(ticket)).toBe(false);
  });

  it('exchanges a ticket for one browser session and rejects replay', async () => {
    const tickets = new BrowserTicketStore();
    const ticket = tickets.issue(30_000);
    const server = await startWebServer({
      port: 0,
      browserTickets: tickets,
      invoke: vi.fn(),
      subscribe: () => () => undefined,
      asset: vi.fn(),
    });
    try {
      const accepted = await fetch(`${server.origin}/api/session?ticket=${ticket}`);
      const replayed = await fetch(`${server.origin}/api/session?ticket=${ticket}`);
      expect(accepted.status).toBe(200);
      expect(accepted.headers.get('set-cookie')).toContain('HttpOnly');
      expect(replayed.status).toBe(401);
    } finally {
      await server.close();
    }
  });
});
