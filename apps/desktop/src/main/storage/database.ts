import Database from 'better-sqlite3';
import { join } from 'node:path';
import { migrateDatabase } from './migrations';

export type DatabaseOpener = (path: string) => Database.Database;
export type DatabaseMigrator = (database: Database.Database) => void;
export type DatabaseOpenResult =
  | Readonly<{ status: 'ready'; database: Database.Database }>
  | Readonly<{ status: 'repair'; code: 'DATABASE_MIGRATION_FAILED' }>;
export type WalCheckpoint = Readonly<{
  busyFrames: number;
  logFrames: number;
  checkpointedFrames: number;
}>;

export function openDatabase(path: string): Database.Database {
  const database = new Database(path);

  try {
    database.pragma('foreign_keys = ON');
    if (path !== ':memory:') database.pragma('journal_mode = WAL');
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

export class ApplicationDatabase {
  private database: Database.Database | undefined;

  constructor(
    private readonly open: DatabaseOpener = openDatabase,
    private readonly migrate: DatabaseMigrator = migrateDatabase,
  ) {}

  start(dataDirectory: string): DatabaseOpenResult {
    const database = this.open(join(dataDirectory, 'catbots.db'));

    try {
      this.migrate(database);
      this.database = database;
      return { status: 'ready', database };
    } catch {
      database.close();
      return { status: 'repair', code: 'DATABASE_MIGRATION_FAILED' };
    }
  }

  close(): void {
    this.database?.close();
    this.database = undefined;
  }

  checkpointWal(): WalCheckpoint {
    if (this.database === undefined) throw new Error('DATABASE_NOT_READY');
    const rows = this.database.pragma('wal_checkpoint(TRUNCATE)') as Array<{
      busy: number;
      log: number;
      checkpointed: number;
    }>;
    const row = rows[0];
    if (row === undefined) throw new Error('DATABASE_CHECKPOINT_FAILED');
    return {
      busyFrames: row.busy,
      logFrames: row.log,
      checkpointedFrames: row.checkpointed,
    };
  }
}
