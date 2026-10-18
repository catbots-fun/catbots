import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { syncDirectory } from './durable-filesystem';
import type { InstallJournal, InstallPhase } from './types';

const phases = [
  'prepared',
  'release-verified',
  'maintenance-prepared',
  'data-snapshotted',
  'old-app-staged',
  'new-app-installed',
  'launch-agent-written',
  'candidate-verifying',
  'committed',
  'rolling-back',
  'rolled-back',
  'complete',
] as const satisfies readonly InstallPhase[];

const journalSchema = z.strictObject({
  schemaVersion: z.literal(1),
  operationId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/),
  phase: z.enum(phases),
  desiredReleaseId: z.string().min(1).max(160),
  previousReleaseId: z.string().min(1).max(160).optional(),
  desiredService: z.enum(['running', 'stopped']),
  preserveData: z.boolean(),
  paths: z.strictObject({
    home: z.string().startsWith('/'),
    application: z.string().startsWith('/'),
    command: z.string().startsWith('/'),
    launchAgent: z.string().startsWith('/'),
    installerState: z.string().startsWith('/'),
    productData: z.string().startsWith('/'),
  }),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});

const secretField = /(api.?key|authorization|credential|private.?key|browser.?ticket|wallet|secret)/i;

export class InstallStore {
  private readonly journalPath: string;
  private readonly lockPath: string;

  constructor(private readonly directory: string) {
    this.journalPath = join(directory, 'install-journal.json');
    this.lockPath = join(directory, 'install.lock');
  }

  async lock(operationId: string): Promise<Readonly<{ release(): Promise<void> }>> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    let handle;
    try {
      handle = await open(this.lockPath, 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('INSTALL_LOCKED');
      throw error;
    }
    await handle.writeFile(`${operationId}\n`, 'utf8');
    await handle.sync();
    await syncDirectory(this.directory);
    let released = false;
    return Object.freeze({
      release: async () => {
        if (released) return;
        released = true;
        await handle.close();
        await rm(this.lockPath, { force: true });
        await syncDirectory(this.directory);
      },
    });
  }

  async readJournal(): Promise<InstallJournal | undefined> {
    let serialized: string;
    try {
      serialized = await readFile(this.journalPath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    try {
      const parsed = journalSchema.safeParse(JSON.parse(serialized));
      if (!parsed.success) throw new Error('INSTALL_JOURNAL_CORRUPT');
      return Object.freeze(parsed.data);
    } catch (error) {
      if (error instanceof Error && error.message === 'INSTALL_JOURNAL_CORRUPT') throw error;
      throw new Error('INSTALL_JOURNAL_CORRUPT');
    }
  }

  async writeJournal(value: InstallJournal): Promise<void> {
    if (containsSecretField(value)) throw new Error('INSTALL_JOURNAL_SECRET_FIELD');
    const parsed = journalSchema.safeParse(value);
    if (!parsed.success) throw new Error('INSTALL_JOURNAL_INVALID');
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const current = await this.readJournal();
    if (current !== undefined) {
      if (current.operationId !== parsed.data.operationId) throw new Error('INSTALL_OPERATION_CONFLICT');
      if (phases.indexOf(parsed.data.phase) < phases.indexOf(current.phase)) {
        throw new Error('INSTALL_PHASE_REGRESSION');
      }
    }

    const temporaryPath = join(this.directory, `.install-journal.${process.pid}.${randomUUID()}.tmp`);
    const handle = await open(temporaryPath, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(parsed.data)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temporaryPath, this.journalPath);
      await syncDirectory(this.directory);
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw error;
    }
  }

  async clearJournal(operationId: string): Promise<void> {
    const current = await this.readJournal();
    if (current === undefined) return;
    if (current.operationId !== operationId) throw new Error('INSTALL_OPERATION_CONFLICT');
    await rm(this.journalPath, { force: true });
    await syncDirectory(this.directory);
  }
}
function containsSecretField(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, nested]) => secretField.test(key) || containsSecretField(nested));
}
