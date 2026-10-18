import { randomUUID } from 'node:crypto';
import {
  access,
  cp,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  statfs,
} from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { syncDirectory } from './durable-filesystem';

export type SnapshotRecord = Readonly<{
  schemaVersion: 1;
  operationId: string;
  complete: true;
  createdAt: string;
}>;

type SnapshotStoreDependencies = Readonly<{
  availableBytes?: (path: string) => Promise<number>;
  now?: () => Date;
}>;

const operationPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/;

export class SnapshotStore {
  private readonly snapshotsDirectory: string;
  private readonly availableBytes: (path: string) => Promise<number>;
  private readonly now: () => Date;

  constructor(
    private readonly stateDirectory: string,
    private readonly productDataDirectory: string,
    dependencies: SnapshotStoreDependencies = {},
  ) {
    this.snapshotsDirectory = join(stateDirectory, 'snapshots');
    this.availableBytes = dependencies.availableBytes ?? filesystemAvailableBytes;
    this.now = dependencies.now ?? (() => new Date());
  }

  async create(input: Readonly<{ operationId: string; requiredBytes: number }>): Promise<SnapshotRecord> {
    assertOperationId(input.operationId);
    if (!Number.isSafeInteger(input.requiredBytes) || input.requiredBytes < 0) {
      throw new Error('SNAPSHOT_REQUIRED_BYTES_INVALID');
    }
    await mkdir(this.snapshotsDirectory, { recursive: true, mode: 0o700 });
    if (await this.availableBytes(this.stateDirectory) < input.requiredBytes) {
      throw new Error('INSTALL_DISK_SPACE_INSUFFICIENT');
    }

    const destination = this.snapshotPath(input.operationId);
    const existing = await this.read(input.operationId);
    if (existing !== undefined) return existing;
    const staging = `${destination}.staging-${randomUUID()}`;
    await mkdir(staging, { mode: 0o700 });
    try {
      if (await exists(this.productDataDirectory)) {
        await assertTreeContainsNoSymlinks(this.productDataDirectory);
        await cp(this.productDataDirectory, join(staging, 'data'), {
          recursive: true,
          preserveTimestamps: true,
          errorOnExist: true,
          force: false,
        });
      } else {
        await mkdir(join(staging, 'data'), { mode: 0o700 });
      }
      const record: SnapshotRecord = Object.freeze({
        schemaVersion: 1,
        operationId: input.operationId,
        complete: true,
        createdAt: this.now().toISOString(),
      });
      await writeDurableFile(join(staging, 'snapshot.json'), `${JSON.stringify(record)}\n`);
      await rename(staging, destination);
      await syncDirectory(this.snapshotsDirectory);
      return record;
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      throw error;
    }
  }

  async restore(operationId: string): Promise<void> {
    const record = await this.read(operationId);
    if (record === undefined) throw new Error('SNAPSHOT_NOT_FOUND');
    const source = join(this.snapshotPath(operationId), 'data');
    await assertTreeContainsNoSymlinks(source);

    const parent = dirname(this.productDataDirectory);
    const name = basename(this.productDataDirectory);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const restore = join(parent, `.${name}.restore-${randomUUID()}`);
    const previous = join(parent, `.${name}.previous-${randomUUID()}`);
    await cp(source, restore, { recursive: true, preserveTimestamps: true, errorOnExist: true, force: false });
    const hadPrevious = await exists(this.productDataDirectory);
    try {
      if (hadPrevious) await rename(this.productDataDirectory, previous);
      await rename(restore, this.productDataDirectory);
      await syncDirectory(parent);
      await rm(previous, { recursive: true, force: true });
    } catch (error) {
      await rm(restore, { recursive: true, force: true });
      if (hadPrevious && await exists(previous) && !await exists(this.productDataDirectory)) {
        await rename(previous, this.productDataDirectory);
        await syncDirectory(parent);
      }
      throw error;
    }
  }

  async prune(input: Readonly<{
    newestSuccessfulOperationId?: string;
    unresolvedOperationIds: readonly string[];
  }>): Promise<void> {
    const keep = new Set(input.unresolvedOperationIds);
    if (input.newestSuccessfulOperationId !== undefined) keep.add(input.newestSuccessfulOperationId);
    let entries;
    try {
      entries = await readdir(this.snapshotsDirectory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      if (entry.isDirectory() && operationPattern.test(entry.name) && !keep.has(entry.name)) {
        await rm(join(this.snapshotsDirectory, entry.name), { recursive: true, force: true });
      }
    }
    await syncDirectory(this.snapshotsDirectory);
  }

  private snapshotPath(operationId: string): string {
    assertOperationId(operationId);
    return join(this.snapshotsDirectory, operationId);
  }

  private async read(operationId: string): Promise<SnapshotRecord | undefined> {
    let value: unknown;
    try {
      value = JSON.parse(await readFile(join(this.snapshotPath(operationId), 'snapshot.json'), 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        if (!await exists(this.snapshotPath(operationId))) return undefined;
        throw new Error('SNAPSHOT_CORRUPT');
      }
      throw new Error('SNAPSHOT_CORRUPT');
    }
    if (value === null || typeof value !== 'object') throw new Error('SNAPSHOT_CORRUPT');
    const candidate = value as Record<string, unknown>;
    if (Object.keys(candidate).sort().join(',') !== 'complete,createdAt,operationId,schemaVersion'
      || candidate.schemaVersion !== 1 || candidate.operationId !== operationId || candidate.complete !== true
      || typeof candidate.createdAt !== 'string' || Number.isNaN(Date.parse(candidate.createdAt))) {
      throw new Error('SNAPSHOT_CORRUPT');
    }
    return candidate as SnapshotRecord;
  }
}
function assertOperationId(value: string): void {
  if (!operationPattern.test(value)) throw new Error('SNAPSHOT_OPERATION_ID_INVALID');
}

async function assertTreeContainsNoSymlinks(root: string): Promise<void> {
  const status = await lstat(root);
  if (status.isSymbolicLink()) throw new Error('SNAPSHOT_SOURCE_UNSAFE');
  if (!status.isDirectory()) return;
  for (const entry of await readdir(root)) await assertTreeContainsNoSymlinks(join(root, entry));
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function filesystemAvailableBytes(path: string): Promise<number> {
  const value = await statfs(path, { bigint: true });
  const available = value.bavail * value.bsize;
  return available > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(available);
}

async function writeDurableFile(path: string, value: string): Promise<void> {
  const handle = await open(path, 'wx', 0o600);
  try {
    await handle.writeFile(value, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(dirname(path));
}
