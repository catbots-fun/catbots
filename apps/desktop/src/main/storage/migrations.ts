import type Database from 'better-sqlite3';

type Migration = Readonly<{ version: number; sql: string }>;

const migrations: readonly Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE bots (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        market TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('draft','paper','live','paused','stopped','error','recovering')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `,
  },
  {
    version: 2,
    sql: `
      CREATE TABLE strategy_revisions (
        bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
        version INTEGER NOT NULL CHECK (version > 0),
        strategy_id TEXT NOT NULL,
        name TEXT NOT NULL,
        document_json TEXT NOT NULL,
        document_hash TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('draft', 'approved')),
        created_at TEXT NOT NULL,
        approved_at TEXT,
        PRIMARY KEY (bot_id, version),
        UNIQUE (bot_id, document_hash)
      );

      CREATE TRIGGER strategy_revisions_document_is_immutable
      BEFORE UPDATE OF bot_id, version, strategy_id, name, document_json, document_hash, created_at
      ON strategy_revisions
      BEGIN
        SELECT RAISE(ABORT, 'strategy revision document is immutable');
      END;

      CREATE TABLE chat_messages (
        id TEXT PRIMARY KEY,
        bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
        content TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX chat_messages_by_bot ON chat_messages (bot_id, created_at);

      CREATE TABLE backtest_traces (
        artifact_hash TEXT PRIMARY KEY,
        artifact_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE backtest_runs (
        id TEXT PRIMARY KEY,
        bot_id TEXT NOT NULL,
        revision_version INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'cancelled', 'failed')),
        data_source TEXT NOT NULL CHECK (data_source = 'Bundled sample data'),
        started_at TEXT NOT NULL,
        completed_at TEXT,
        summary_json TEXT NOT NULL,
        artifact_hash TEXT NOT NULL REFERENCES backtest_traces(artifact_hash),
        FOREIGN KEY (bot_id, revision_version) REFERENCES strategy_revisions(bot_id, version) ON DELETE CASCADE
      );

      CREATE INDEX strategy_revisions_by_bot ON strategy_revisions (bot_id, version DESC);
      CREATE INDEX backtest_runs_by_bot ON backtest_runs (bot_id, started_at DESC);
    `,
  },
  {
    version: 3,
    sql: `
      CREATE TABLE deployments (
        id TEXT PRIMARY KEY,
        bot_id TEXT NOT NULL,
        strategy_id TEXT NOT NULL,
        strategy_version INTEGER NOT NULL CHECK (strategy_version > 0),
        mode TEXT NOT NULL CHECK (mode IN ('paper', 'live')),
        venue TEXT NOT NULL CHECK (venue IN ('paper', 'hyperliquid')),
        network TEXT NOT NULL CHECK (network IN ('paper', 'testnet')),
        masked_account TEXT,
        market_bindings_json TEXT NOT NULL,
        risk_limits_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('preflight', 'running', 'paused', 'stopping', 'stopped', 'recovering', 'suspended', 'error')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (bot_id, strategy_version) REFERENCES strategy_revisions(bot_id, version) ON DELETE RESTRICT
      );

      CREATE TRIGGER deployments_strategy_binding_is_immutable
      BEFORE UPDATE OF bot_id, strategy_id, strategy_version, mode, venue, network, masked_account, market_bindings_json, risk_limits_json, created_at
      ON deployments
      BEGIN
        SELECT RAISE(ABORT, 'deployment binding is immutable');
      END;

      CREATE TABLE audit_traces (
        id TEXT PRIMARY KEY,
        deployment_id TEXT NOT NULL REFERENCES deployments(id) ON DELETE RESTRICT,
        trigger_event_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK (status IN ('open', 'completed', 'failed')) DEFAULT 'open',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE audit_events (
        id TEXT PRIMARY KEY,
        trace_id TEXT NOT NULL REFERENCES audit_traces(id) ON DELETE RESTRICT,
        sequence INTEGER NOT NULL CHECK (sequence > 0),
        type TEXT NOT NULL,
        event_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (trace_id, sequence)
      );

      CREATE TRIGGER audit_events_are_append_only_update
      BEFORE UPDATE ON audit_events
      BEGIN SELECT RAISE(ABORT, 'audit events are append-only'); END;

      CREATE TRIGGER audit_events_are_append_only_delete
      BEFORE DELETE ON audit_events
      BEGIN SELECT RAISE(ABORT, 'audit events are append-only'); END;

      CREATE TABLE execution_outbox (
        id TEXT PRIMARY KEY,
        deployment_id TEXT NOT NULL REFERENCES deployments(id) ON DELETE RESTRICT,
        trace_id TEXT NOT NULL REFERENCES audit_traces(id) ON DELETE RESTRICT,
        action_node_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        client_order_id TEXT NOT NULL UNIQUE,
        intent_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'claimed', 'acknowledged', 'rejected', 'unknown')) DEFAULT 'pending',
        attempts INTEGER NOT NULL CHECK (attempts >= 0) DEFAULT 0,
        claimed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX deployments_by_bot ON deployments (bot_id, created_at DESC);
      CREATE INDEX audit_events_by_trace ON audit_events (trace_id, sequence);
      CREATE INDEX execution_outbox_by_status ON execution_outbox (status, created_at);
    `,
  },
  {
    version: 4,
    sql: `
      ALTER TABLE bots ADD COLUMN dex TEXT NOT NULL DEFAULT 'hyperliquid';
      ALTER TABLE bots ADD COLUMN legacy_market_hint TEXT;
      UPDATE bots
      SET legacy_market_hint = market
      WHERE market <> '' AND legacy_market_hint IS NULL;
    `,
  },
  {
    version: 5,
    sql: `
      UPDATE bots
      SET legacy_market_hint = COALESCE(NULLIF(legacy_market_hint, ''), NULLIF(market, ''), '');
      ALTER TABLE bots DROP COLUMN market;

      ALTER TABLE deployments ADD COLUMN record_version INTEGER CHECK (record_version IN (1, 2));
      ALTER TABLE deployments ADD COLUMN dex TEXT CHECK (dex IN ('hyperliquid'));
      ALTER TABLE deployments ADD COLUMN execution_venue TEXT CHECK (execution_venue IN ('paper', 'hyperliquid'));
      ALTER TABLE deployments ADD COLUMN market_access_json TEXT;

      DROP TRIGGER deployments_strategy_binding_is_immutable;
      CREATE TRIGGER deployments_strategy_binding_is_immutable
      BEFORE UPDATE OF bot_id, strategy_id, strategy_version, record_version, mode, venue, execution_venue,
        network, masked_account, market_bindings_json, market_access_json, dex, risk_limits_json, created_at
      ON deployments
      BEGIN
        SELECT RAISE(ABORT, 'deployment binding is immutable');
      END;
    `,
  },
  {
    version: 6,
    sql: `
      ALTER TABLE audit_traces ADD COLUMN parent_trace_id TEXT;
      ALTER TABLE audit_traces ADD COLUMN market TEXT;
      ALTER TABLE audit_traces ADD COLUMN dex TEXT CHECK (dex IN ('hyperliquid'));
      ALTER TABLE audit_traces ADD COLUMN universe_revision TEXT;
      ALTER TABLE audit_traces ADD COLUMN context_observed_at TEXT;

      CREATE INDEX audit_traces_by_deployment_parent
        ON audit_traces (deployment_id, parent_trace_id);
      CREATE INDEX audit_traces_by_deployment_market_created
        ON audit_traces (deployment_id, market, created_at);
    `,
  },
  { version: 7, sql: `ALTER TABLE bots ADD COLUMN deleted_at TEXT;` },
];

export const currentDataSchemaVersion = migrations[migrations.length - 1]!.version;

export function migrateDatabase(database: Database.Database): void {
  database.transaction(() => {
    database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
    `);

    const hasMigration = database.prepare('SELECT 1 FROM schema_migrations WHERE version = ?');
    const recordMigration = database.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)');
    for (const migration of migrations) {
      if (hasMigration.get(migration.version) !== undefined) continue;
      database.exec(migration.sql);
      const foreignKeyViolations = database.pragma('foreign_key_check') as unknown[];
      if (foreignKeyViolations.length > 0) throw new Error('Database foreign key verification failed');
      recordMigration.run(migration.version, new Date().toISOString());
    }
  })();
}
