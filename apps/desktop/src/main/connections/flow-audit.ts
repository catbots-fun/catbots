import Database from 'better-sqlite3';
import { chmodSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

import type { FlowAuditEvent, FlowAuditRecord, FlowAuditSummary } from '@catbots/contracts';
export type { FlowAuditEvent, FlowAuditRecord } from '@catbots/contracts';

function redact(value: unknown, key = ''): unknown {
  if (/secret|password|authorization|api.?key|private.?key|access.?token|refresh.?token|mnemonic|seed.?phrase/i.test(key)) return '[REDACTED]';
  if (typeof value === 'string') return value
    .replace(/Bearer\s+[^\s"',;]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:0x)?[a-f0-9]{64,}\b/gi, '[REDACTED]');
  if (Array.isArray(value)) return value.map(item => redact(item));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redact(item, name)]));
  return value;
}

/** Separate from recovery state: an event is evidence, never authority to resend. */
export class FlowAuditStore {
  constructor(private readonly path: string) {}

  private use<T>(operation: (db: Database.Database) => T): T {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const db = new Database(this.path);
    try {
      chmodSync(this.path, 0o600);
      db.pragma('synchronous = FULL');
      db.exec(`CREATE TABLE IF NOT EXISTS flow_audit (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        bot_id TEXT NOT NULL,
        payload TEXT NOT NULL
      ); CREATE INDEX IF NOT EXISTS flow_audit_bot_sequence ON flow_audit(bot_id, sequence);`);
      return operation(db);
    } finally { db.close(); }
  }

  append(event: FlowAuditEvent): void {
    const payload = JSON.stringify({ ...event, at: new Date().toISOString(), details: redact(event.details) });
    if (Buffer.byteLength(payload, 'utf8') > 1024 * 1024) throw new Error('AUDIT_EVENT_TOO_LARGE');
    this.use(db => db.prepare('INSERT INTO flow_audit (bot_id, payload) VALUES (?, ?)').run(event.botId, payload));
  }

  summary(botId: string): FlowAuditSummary {
    if (!existsSync(this.path)) return { count: 0, through: 0, databaseBytes: 0, retention: 'keep_all' };
    return this.use(db => {
      const row = db.prepare('SELECT COUNT(*) AS count, COALESCE(MAX(sequence), 0) AS through FROM flow_audit WHERE bot_id = ?').get(botId) as { count: number; through: number };
      return { ...row, databaseBytes: statSync(this.path).size, retention: 'keep_all' };
    });
  }

  list(botId: string, after = 0, limit = 50, through = Number.MAX_SAFE_INTEGER): FlowAuditRecord[] {
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('INVALID_AUDIT_PAGE');
    if (!Number.isSafeInteger(through) || through < 0) throw new Error('INVALID_AUDIT_PAGE');
    if (!existsSync(this.path)) return [];
    return this.use(db => {
      const rows = db.prepare('SELECT sequence, payload FROM flow_audit WHERE bot_id = ? AND sequence > ? AND sequence <= ? ORDER BY sequence ASC LIMIT ?').all(botId, after, through, limit) as { sequence: number; payload: string }[];
      return rows.map(row => ({ ...JSON.parse(row.payload), sequence: row.sequence }));
    });
  }
}
