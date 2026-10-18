import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { BotRepository } from '../src/main/bots/bot-repository';
import { openDatabase } from '../src/main/storage/database';
import { migrateDatabase } from '../src/main/storage/migrations';

const databases: Database.Database[] = [];

function createDatabase(): Database.Database {
  const db = openDatabase(':memory:');
  databases.push(db);
  migrateDatabase(db);
  return db;
}

afterEach(() => {
  databases.splice(0).forEach((database) => database.close());
});

describe('BotRepository', () => {
  it('persists a Draft bot with deterministic timestamps', () => {
    const database = createDatabase();
    const bots = new BotRepository(database, () => new Date('2026-09-03T12:00:00.000Z'));

    const created = bots.createDraft({ name: 'BTC Flow', dex: 'hyperliquid' });

    expect(created).toMatchObject({
      name: 'BTC Flow',
      dex: 'hyperliquid',
      status: 'draft',
      createdAt: '2026-09-03T12:00:00.000Z',
      updatedAt: '2026-09-03T12:00:00.000Z',
    });
    expect(created.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(created).not.toHaveProperty('market');
    expect(created).not.toHaveProperty('legacyMarketHint');
    expect(bots.list()).toEqual([created]);
    expect(database.prepare('SELECT dex, legacy_market_hint FROM bots WHERE id = ?').get(created.id)).toEqual({
      dex: 'hyperliquid', legacy_market_hint: '',
    });
  });

  it('returns draft bots in creation order', () => {
    let now = new Date('2026-09-03T12:00:00.000Z');
    const bots = new BotRepository(createDatabase(), () => now);
    const first = bots.createDraft({ name: 'BTC Flow', market: 'BTC-PERP' });
    now = new Date('2026-09-03T12:01:00.000Z');
    const second = bots.createDraft({ name: 'ETH Flow', market: 'ETH-PERP' });

    expect(bots.list()).toEqual([first, second]);
  });

  it('validates stored bot rows through the shared summary schema', () => {
    const db = createDatabase();
    db.prepare(
      'INSERT INTO bots (id, name, dex, legacy_market_hint, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run('not-a-uuid', 'BTC Flow', 'hyperliquid', 'BTC-PERP', 'draft', '2026-09-03T12:00:00.000Z', '2026-09-03T12:00:00.000Z');

    expect(() => new BotRepository(db).list()).toThrow();
  });
});

it('removes a bot from the list without deleting its audit identity or other bots', () => {
  const database=createDatabase();
  const bots=new BotRepository(database);
  const removed=bots.createDraft({name:'Remove me',dex:'hyperliquid'});
  const kept=bots.createDraft({name:'Keep me',dex:'hyperliquid'});
  bots.remove(removed.id);
  bots.remove(removed.id);
  expect(bots.list()).toEqual([kept]);
  expect(database.prepare('SELECT deleted_at FROM bots WHERE id = ?').get(removed.id)).toMatchObject({deleted_at:expect.any(String)});
});

it('reports existence only for bots that have not been deleted', () => {
  const bots = new BotRepository(createDatabase());
  const deleted = bots.createDraft({ name: 'Deleted', dex: 'hyperliquid' });
  const existing = bots.createDraft({ name: 'Existing', dex: 'hyperliquid' });

  bots.remove(deleted.id);

  expect(bots.exists(deleted.id)).toBe(false);
  expect(bots.exists(existing.id)).toBe(true);
  expect(bots.exists('00000000-0000-4000-8000-000000000099')).toBe(false);
});
