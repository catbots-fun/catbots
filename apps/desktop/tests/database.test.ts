import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExecutionRepository } from '../src/main/execution/execution-repository';
import { ApplicationDatabase, openDatabase } from '../src/main/storage/database';
import { migrateDatabase } from '../src/main/storage/migrations';
import { WorkbenchRepository } from '../src/main/workbench/workbench-repository';
import { WorkbenchService } from '../src/main/workbench/workbench-service';

const databases: Database.Database[] = [];
const temporaryDirectories: string[] = [];

function trackDatabase(db: Database.Database): Database.Database {
  databases.push(db);
  return db;
}

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'catbots-database-'));
  temporaryDirectories.push(directory);
  return directory;
}

const legacyDeploymentId = '028f3f75-89ab-7def-8123-456789abcdef';

function seedVersion3Database(): Database.Database {
  const db = trackDatabase(openDatabase(':memory:'));
  db.exec(`
    CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
    INSERT INTO schema_migrations VALUES
      (1, '2026-09-01T00:00:00.000Z'),
      (2, '2026-09-01T00:00:00.000Z'),
      (3, '2026-09-01T00:00:00.000Z');

    CREATE TABLE bots (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      market TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE strategy_revisions (
      bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
      version INTEGER NOT NULL,
      strategy_id TEXT NOT NULL,
      name TEXT NOT NULL,
      document_json TEXT NOT NULL,
      document_hash TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      approved_at TEXT,
      PRIMARY KEY (bot_id, version)
    );
    CREATE TABLE deployments (
      id TEXT PRIMARY KEY,
      bot_id TEXT NOT NULL,
      strategy_id TEXT NOT NULL,
      strategy_version INTEGER NOT NULL,
      mode TEXT NOT NULL,
      venue TEXT NOT NULL,
      network TEXT NOT NULL,
      masked_account TEXT,
      market_bindings_json TEXT NOT NULL,
      risk_limits_json TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (bot_id, strategy_version) REFERENCES strategy_revisions(bot_id, version) ON DELETE RESTRICT
    );
    CREATE TRIGGER deployments_strategy_binding_is_immutable
    BEFORE UPDATE OF bot_id, strategy_id, strategy_version, mode, venue, network, masked_account,
      market_bindings_json, risk_limits_json, created_at
    ON deployments
    BEGIN SELECT RAISE(ABORT, 'deployment binding is immutable'); END;

    CREATE TABLE audit_traces (
      id TEXT PRIMARY KEY,
      deployment_id TEXT NOT NULL REFERENCES deployments(id) ON DELETE RESTRICT,
      trigger_event_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'open',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    INSERT INTO bots VALUES (
      '018f47a2-4a2a-7c5d-9b61-3a83f64406a8', 'Legacy bot', 'BTC-PERP', 'paper',
      '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z'
    );
    INSERT INTO strategy_revisions VALUES (
      '018f47a2-4a2a-7c5d-9b61-3a83f64406a8', 1, 'legacy-strategy', 'Legacy strategy',
      '{"schemaVersion":"1.0","strategy":{"id":"legacy-strategy","name":"Legacy strategy","version":1},"nodes":[{"id":"clock","kind":"trigger","type":"trigger.interval","version":1,"config":{"every":"15m","alignment":"utc"}},{"id":"flat","kind":"condition","type":"predicate.position_state","version":1,"config":{"state":"flat","market":"BTC-PERP"}}],"edges":[{"id":"e1","source":"clock","sourcePort":"activation","target":"flat","targetPort":"activation"}]}',
      'sha256:legacy-strategy', 'approved', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z'
    );
    INSERT INTO deployments VALUES (
      '${legacyDeploymentId}', '018f47a2-4a2a-7c5d-9b61-3a83f64406a8', 'legacy-strategy', 1,
      'paper', 'paper', 'paper', NULL, '["BTC-PERP"]',
      '{"maxOrderUsd":"1000","maxPositionUsd":"2500","maxLeverage":3,"maxDailyLossUsd":"300","maxDrawdownPercent":12,"allowedMarkets":["BTC-PERP"],"allowedSides":["long","short"],"maxOrdersPerMinute":4}',
      'running', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z'
    );
  `);
  return db;
}

afterEach(async () => {
  databases.splice(0).forEach((database) => database.close());
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

describe('openDatabase', () => {
  it('enables foreign keys and WAL for file databases', async () => {
    const db = trackDatabase(openDatabase(join(await createTemporaryDirectory(), 'catbots.db')));

    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
  });

  it('enables foreign keys without requesting WAL for memory databases', () => {
    const db = trackDatabase(openDatabase(':memory:'));

    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.pragma('journal_mode', { simple: true })).toBe('memory');
  });
});

describe('ApplicationDatabase maintenance', () => {
  it('checkpoints the WAL to zero frames before maintenance', async () => {
    const application = new ApplicationDatabase();
    const directory = await createTemporaryDirectory();
    expect(application.start(directory).status).toBe('ready');

    expect(application.checkpointWal()).toEqual({
      busyFrames: 0,
      logFrames: 0,
      checkpointedFrames: 0,
    });
    application.close();
  });
});

describe('migrateDatabase', () => {
  it('opens a saved v3 Backtest and its legacy trace after migration without rewriting either artifact', async () => {
    const db = seedVersion3Database();
    const botId = '018f47a2-4a2a-7c5d-9b61-3a83f64406a8';
    const timestamp = '2026-09-01T00:00:00.000Z';
    db.exec(`
      CREATE TABLE chat_messages (id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES bots(id), role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE backtest_traces (artifact_hash TEXT PRIMARY KEY, artifact_json TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE backtest_runs (id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, revision_version INTEGER NOT NULL,
        status TEXT NOT NULL, data_source TEXT NOT NULL, started_at TEXT NOT NULL, completed_at TEXT,
        summary_json TEXT NOT NULL, artifact_hash TEXT NOT NULL REFERENCES backtest_traces(artifact_hash),
        FOREIGN KEY (bot_id, revision_version) REFERENCES strategy_revisions(bot_id, version));
    `);
    const artifact = JSON.stringify({ traces: [[{ traceId: 'legacy-trace', sequence: 1, type: 'flow.skipped', createdAt: timestamp, details: { reason: 'condition.not_true' } }]] });
    const artifactHash = `sha256:${createHash('sha256').update(artifact).digest('hex')}`;
    const summary = JSON.stringify({
      id: '048f47a2-4a2a-7c5d-9b61-3a83f64406a8', botId, revisionVersion: 1, status: 'completed', dataSource: 'Bundled sample data',
      startedAt: timestamp, completedAt: timestamp,
      assumptions: { from: '2026-08-01T00:00:00.000Z', to: timestamp, startingCapital: '10000', feeRateBps: 3.5, slippageBps: 1 },
      metrics: { returnPercent: 0, maximumDrawdownPercent: 0, sharpeLike: 0, winRatePercent: 0, tradeCount: 0, fees: '0', funding: '0' },
      equityCurve: [{ timestamp, equity: '10000' }], trades: [], warnings: [],
      traces: [{ traceId: 'legacy-trace', outcome: 'skipped', occurredAt: timestamp, summary: 'No action' }], artifactHash,
    });
    db.prepare('INSERT INTO backtest_traces VALUES (?, ?, ?)').run(artifactHash, artifact, timestamp);
    db.prepare('INSERT INTO backtest_runs VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)')
      .run('048f47a2-4a2a-7c5d-9b61-3a83f64406a8', botId, 'completed', 'Bundled sample data', timestamp, timestamp, summary, artifactHash);
    migrateDatabase(db);
    const repository = new WorkbenchRepository(db);
    const projected = repository.getState(botId).backtests[0]!;
    expect(projected).toMatchObject({ artifactHash, legacyProjection: true, datasetCoverage: null, perMarket: [],
      metrics: { endingEquity: '10000', realizedPnl: null }, traces: [{ parentTraceId: null, market: 'BTC-PERP' }] });
    const service = new WorkbenchService({ repository, configRepository: { load: async () => null } });
    expect(await service.getTrace({ botId, traceId: 'legacy-trace' })).toMatchObject({ parentTraceId: null, market: 'BTC-PERP', events: [{ type: 'flow.skipped' }] });
    expect(repository.getTraceArtifact(botId, artifactHash)).toBe(artifact);
    expect(db.prepare('SELECT summary_json FROM backtest_runs').get()).toEqual({ summary_json: summary });
  });
  it('applies every schema migration once when called repeatedly', () => {
    const db = trackDatabase(openDatabase(':memory:'));

    migrateDatabase(db);
    migrateDatabase(db);

    expect(db.prepare('SELECT version FROM schema_migrations ORDER BY version').all()).toEqual([
      { version: 1 },
      { version: 2 },
      { version: 3 },
      { version: 4 },
      { version: 5 },
      { version: 6 },
    ]);
    expect(db.prepare("SELECT name FROM pragma_table_info('bots') ORDER BY cid").all()).not.toContainEqual({ name: 'market' });
    expect(db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name IN (
        'bots', 'strategy_revisions', 'chat_messages', 'backtest_runs', 'backtest_traces',
        'deployments', 'audit_traces', 'audit_events', 'execution_outbox'
      )
      ORDER BY name
    `).all()).toEqual([
      { name: 'audit_events' },
      { name: 'audit_traces' },
      { name: 'backtest_runs' },
      { name: 'backtest_traces' },
      { name: 'bots' },
      { name: 'chat_messages' },
      { name: 'deployments' },
      { name: 'execution_outbox' },
      { name: 'strategy_revisions' },
    ]);
  });

  it('rolls back an incomplete migration when schema creation fails', () => {
    const db = trackDatabase(openDatabase(':memory:'));
    db.exec('CREATE TABLE bots (id TEXT PRIMARY KEY)');

    expect(() => migrateDatabase(db)).toThrow(/bots/i);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").all()).toEqual([]);
  });

  it('upgrades an existing version 1 database without recreating bots', () => {
    const db = trackDatabase(openDatabase(':memory:'));
    db.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      CREATE TABLE bots (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        market TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO schema_migrations VALUES (1, '2026-09-01T00:00:00.000Z');
      INSERT INTO bots VALUES ('bot-1', 'Existing bot', 'BTC-PERP', 'draft', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z');
    `);

    migrateDatabase(db);

    expect(db.prepare('SELECT id, name, dex, legacy_market_hint FROM bots').all()).toEqual([
      { id: 'bot-1', name: 'Existing bot', dex: 'hyperliquid', legacy_market_hint: 'BTC-PERP' },
    ]);
    expect(db.prepare('SELECT version FROM schema_migrations ORDER BY version').all()).toEqual([
      { version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }, { version: 5 }, { version: 6 },
    ]);
  });

  it('migrates version 3 bot identity and deployment scope without rewriting legacy deployment JSON', () => {
    const db = seedVersion3Database();
    const repository = new ExecutionRepository(db);
    const workbench = new WorkbenchRepository(db);
    const bindingsBefore = db.prepare('SELECT market_bindings_json FROM deployments WHERE id = ?')
      .get(legacyDeploymentId);

    migrateDatabase(db);

    const migratedBot = workbench.getStoredIdentity('018f47a2-4a2a-7c5d-9b61-3a83f64406a8');
    const migratedLegacyStrategy = workbench.getStrategyDocument(migratedBot.summary.id, 1);
    const migratedLegacyDeployment = repository.getDeployment(legacyDeploymentId);
    expect(migratedBot.summary).toMatchObject({ dex: 'hyperliquid' });
    expect(migratedBot).toMatchObject({
      summary: { dex: 'hyperliquid' }, legacyMarketHint: 'BTC-PERP',
    });
    expect(migratedLegacyStrategy.schemaVersion).toBe('1.0');
    expect(db.prepare('SELECT market_bindings_json FROM deployments WHERE id = ?').get(legacyDeploymentId))
      .toEqual(bindingsBefore);
    expect(migratedLegacyDeployment).toMatchObject({
      recordVersion: 1, marketBindings: ['BTC-PERP'], status: 'running',
    });
    expect(migratedLegacyDeployment.recordVersion).toBe(1);
    if (migratedLegacyDeployment.recordVersion !== 1) throw new Error('Expected a legacy deployment');
    expect(migratedLegacyDeployment.marketBindings).toEqual(['BTC-PERP']);
    expect(() => repository.requestStop(legacyDeploymentId, '2026-09-05T01:00:00.000Z')).not.toThrow();
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it('finishes the version 5 transition for an already-opened version 4 development database', () => {
    const db = seedVersion3Database();
    db.exec(`
      ALTER TABLE bots ADD COLUMN dex TEXT NOT NULL DEFAULT 'hyperliquid';
      ALTER TABLE bots ADD COLUMN legacy_market_hint TEXT;
      UPDATE bots SET legacy_market_hint = market WHERE market <> '' AND legacy_market_hint IS NULL;
      INSERT INTO schema_migrations VALUES (4, '2026-09-04T00:00:00.000Z');
    `);

    migrateDatabase(db);

    expect(db.prepare('SELECT dex, legacy_market_hint FROM bots').get()).toEqual({
      dex: 'hyperliquid', legacy_market_hint: 'BTC-PERP',
    });
    expect(db.prepare("SELECT name FROM pragma_table_info('bots') WHERE name = 'market'").get()).toBeUndefined();
    expect(db.prepare('SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1').get()).toEqual({ version: 6 });
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it('rolls back a failed migration to version 3 with all original rows and foreign keys intact', () => {
    const db = seedVersion3Database();
    db.pragma('foreign_keys = OFF');
    db.prepare(`
      INSERT INTO deployments VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      '038f3f75-89ab-7def-8123-456789abcdef',
      '018f47a2-4a2a-7c5d-9b61-3a83f64406a8',
      'missing-strategy', 2, 'paper', 'paper', 'paper', null, '["ETH-PERP"]', '{}', 'running',
      '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z',
    );
    db.pragma('foreign_keys = ON');

    expect(() => migrateDatabase(db)).toThrow(/foreign key verification/i);
    expect(db.prepare('SELECT version FROM schema_migrations ORDER BY version').all()).toEqual([
      { version: 1 }, { version: 2 }, { version: 3 },
    ]);
    expect(db.prepare("SELECT name FROM pragma_table_info('bots') ORDER BY cid").all()).toEqual([
      { name: 'id' }, { name: 'name' }, { name: 'market' }, { name: 'status' }, { name: 'created_at' }, { name: 'updated_at' },
    ]);
    expect(db.prepare('SELECT id, market FROM bots').all()).toEqual([
      { id: '018f47a2-4a2a-7c5d-9b61-3a83f64406a8', market: 'BTC-PERP' },
    ]);
    expect(db.prepare('SELECT COUNT(*) AS count FROM deployments').get()).toEqual({ count: 2 });
    expect(db.prepare("SELECT \"table\", \"from\", \"to\" FROM pragma_foreign_key_list('deployments')").all()).toContainEqual({
      table: 'strategy_revisions', from: 'bot_id', to: 'bot_id',
    });
  });
});

describe('ApplicationDatabase', () => {
  it('opens and migrates catbots.db in the user data directory, then closes it', async () => {
    const lifecycle = new ApplicationDatabase();
    const dataDirectory = await createTemporaryDirectory();

    const result = lifecycle.start(dataDirectory);
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') throw new Error('Expected ready database');
    const db = result.database;

    expect(db.name).toBe(join(dataDirectory, 'catbots.db'));
    expect(db.prepare('SELECT version FROM schema_migrations ORDER BY version').all()).toEqual([
      { version: 1 },
      { version: 2 },
      { version: 3 },
      { version: 4 },
      { version: 5 },
      { version: 6 },
    ]);
    lifecycle.close();
    expect(db.open).toBe(false);
  });

  it('closes the exact opened database when migration fails', async () => {
    const database = { close: vi.fn() } as unknown as Database.Database;
    const opener = vi.fn(() => database);
    const migrator = vi.fn(() => {
      throw new Error('migration failed');
    });

    const dataDirectory = await createTemporaryDirectory();

    expect(new ApplicationDatabase(opener, migrator).start(dataDirectory)).toEqual({
      status: 'repair', code: 'DATABASE_MIGRATION_FAILED',
    });
    expect(opener).toHaveBeenCalledOnce();
    expect(migrator).toHaveBeenCalledWith(database);
    expect(database.close).toHaveBeenCalledOnce();
  });
});
