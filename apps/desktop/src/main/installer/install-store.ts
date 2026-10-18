import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, open, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
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
  rollbackFromPhase: z.enum(phases).optional(),
  desiredReleaseId: z.string().min(1).max(160),
  previousInstallation: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('absent') }),
    z.strictObject({
      kind: z.literal('installed'),
      releaseId: z.string().min(1).max(160),
      desiredService: z.enum(['running', 'stopped']),
    }),
  ]),
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

export type ProcessIncarnationProvider = Readonly<{
  current(): Promise<Readonly<{ pid: number; incarnation: string }>>;
  isAlive(pid: number): boolean;
  incarnation(pid: number): Promise<string | undefined>;
}>;

type InstallStoreDependencies = Readonly<{
  processes?: ProcessIncarnationProvider;
}>;

const execFileAsync = promisify(execFile);
const fixedProcessIdentityEnvironment = Object.freeze({ LC_ALL: 'C', TZ: 'UTC' });

type ProcessIdentityCommandExecutor = (
  executable: string,
  args: readonly string[],
  options: Readonly<{ env: Readonly<Record<string, string>> }>,
) => Promise<Readonly<{ stdout: string }>>;

export function createNodeProcessIncarnationProvider(input: Readonly<{
  platform?: NodeJS.Platform;
  pid?: number;
  execute?: ProcessIdentityCommandExecutor;
}> = {}): ProcessIncarnationProvider {
  const platform = input.platform ?? process.platform;
  const pid = input.pid ?? process.pid;
  const execute = input.execute ?? executeProcessIdentityCommand;
  let bootIdentity: Promise<string | undefined> | undefined;
  const getBootIdentity = () => {
    bootIdentity ??= readBootIdentity(platform, execute);
    return bootIdentity;
  };
  const incarnation = async (observedPid: number): Promise<string | undefined> => {
    if (!Number.isSafeInteger(observedPid) || observedPid <= 0) return undefined;
    try {
      const [boot, processStart] = await Promise.all([
        getBootIdentity(),
        execute('/bin/ps', ['-o', 'lstart=', '-o', 'comm=', '-p', String(observedPid)], {
          env: fixedProcessIdentityEnvironment,
        }),
      ]);
      const value = processStart.stdout.trim();
      return boot === undefined || value.length === 0 ? undefined : `${boot}\n${value}`;
    } catch {
      return undefined;
    }
  };
  return Object.freeze({
    current: async () => {
      const value = await incarnation(pid);
      if (value === undefined) throw new Error('INSTALL_PROCESS_IDENTITY_UNAVAILABLE');
      return { pid, incarnation: value };
    },
    isAlive: processIsAlive,
    incarnation,
  });
}

const nodeProcessIncarnations = createNodeProcessIncarnationProvider();

export class InstallStore {
  private readonly journalPath: string;
  private readonly lockDirectory: string;
  private readonly processes: ProcessIncarnationProvider;

  constructor(private readonly directory: string, dependencies: InstallStoreDependencies = {}) {
    this.journalPath = join(directory, 'install-journal.json');
    this.lockDirectory = join(directory, 'install-locks');
    this.processes = dependencies.processes ?? nodeProcessIncarnations;
  }

  async lock(operationId: string): Promise<Readonly<{ release(): Promise<void> }>> {
    const lease = await this.createLease(operationId, false);
    let journal;
    try {
      journal = await this.readJournal();
    } catch (error) {
      try {
        await lease.release();
      } catch (releaseError) {
        throw new AggregateError([error, releaseError], 'INSTALL_LOCK_CLEANUP_FAILED');
      }
      throw error;
    }
    if (journal === undefined) return lease;
    await lease.release();
    throw new Error('INSTALL_RECOVERY_REQUIRED');
  }

  async lockForRecovery(operationId: string): Promise<Readonly<{ release(): Promise<void> }>> {
    const journal = await this.readJournal();
    if (journal?.operationId !== operationId) throw new Error('INSTALL_OPERATION_CONFLICT');
    return this.createLease(operationId, true);
  }

  private async createLease(
    operationId: string,
    recovery: boolean,
  ): Promise<Readonly<{ release(): Promise<void> }>> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      await mkdir(this.lockDirectory, { mode: 0o700 });
      await syncDirectory(this.directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const token = randomUUID();
    const processIdentity = await this.processes.current();
    if (!Number.isSafeInteger(processIdentity.pid) || processIdentity.pid <= 0
      || processIdentity.incarnation.length === 0) {
      throw new Error('INSTALL_PROCESS_IDENTITY_UNAVAILABLE');
    }
    const temporaryPath = join(this.lockDirectory, `${token}.tmp`);
    const leasePath = join(this.lockDirectory, `${token}.lease`);
    const owner = {
      operationId,
      pid: processIdentity.pid,
      token,
      processIncarnation: processIdentity.incarnation,
    };
    let handle;
    let published = false;
    try {
      handle = await open(temporaryPath, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify(owner)}\n`, 'utf8');
      await handle.sync();
      await rename(temporaryPath, leasePath);
      published = true;
      await syncDirectory(this.lockDirectory);
    } catch (error) {
      if (handle !== undefined) {
        await handle.close().catch(() => undefined);
        await rm(published ? leasePath : temporaryPath, { force: true }).catch(() => undefined);
        await syncDirectory(this.lockDirectory).catch(() => undefined);
      }
      throw error;
    }

    try {
      const live = await this.liveLeases();
      const winner = live[0];
      if (winner?.token !== token) {
        const winnerOperation = winner?.operationId;
        if (recovery && winnerOperation !== undefined && winnerOperation !== operationId) {
          throw new Error('INSTALL_OPERATION_CONFLICT');
        }
        throw new Error('INSTALL_LOCKED');
      }
    } catch (error) {
      await releaseLease(handle, leasePath, owner, this.lockDirectory).catch(() => undefined);
      throw error;
    }

    let released = false;
    return Object.freeze({
      release: async () => {
        if (released) return;
        await releaseLease(handle, leasePath, owner, this.lockDirectory);
        released = true;
      },
    });
  }

  private async liveLeases(): Promise<LeaseOwner[]> {
    const leases: LeaseOwner[] = [];
    for (const entry of await readdir(this.lockDirectory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.lease')) continue;
      const path = join(this.lockDirectory, entry.name);
      const [owner, status] = await Promise.all([readLeaseOwner(path), stat(path, { bigint: true })]);
      if (!this.processes.isAlive(owner.pid)) continue;
      const incarnation = await this.processes.incarnation(owner.pid);
      if (incarnation === undefined || incarnation === owner.processIncarnation) {
        leases.push({ ...owner, birthtimeNs: status.birthtimeNs, ino: status.ino });
      }
    }
    return leases.sort((left, right) => left.birthtimeNs < right.birthtimeNs
      ? -1
      : left.birthtimeNs > right.birthtimeNs
        ? 1
        : left.ino < right.ino ? -1 : left.ino > right.ino ? 1 : left.token.localeCompare(right.token));
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

type SerializedLeaseOwner = Readonly<{
  operationId: string;
  pid: number;
  token: string;
  processIncarnation: string;
}>;
type LeaseOwner = SerializedLeaseOwner & Readonly<{ birthtimeNs: bigint; ino: bigint }>;

async function readLeaseOwner(path: string): Promise<SerializedLeaseOwner> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    if (Object.keys(value).sort().join(',') !== 'operationId,pid,processIncarnation,token'
      || typeof value.operationId !== 'string' || !Number.isSafeInteger(value.pid) || (value.pid as number) <= 0
      || typeof value.token !== 'string' || value.token.length === 0
      || typeof value.processIncarnation !== 'string' || value.processIncarnation.length === 0) {
      throw new Error('INSTALL_LOCK_CORRUPT');
    }
    return {
      operationId: value.operationId,
      pid: value.pid as number,
      token: value.token,
      processIncarnation: value.processIncarnation,
    };
  } catch (error) {
    if (error instanceof Error && error.message === 'INSTALL_LOCK_CORRUPT') throw error;
    throw new Error('INSTALL_LOCK_CORRUPT');
  }
}

async function releaseLease(
  handle: Awaited<ReturnType<typeof open>>,
  leasePath: string,
  expected: SerializedLeaseOwner,
  lockDirectory: string,
): Promise<void> {
  const held = await handle.stat({ bigint: true });
  let pathStatus;
  let observed;
  try {
    [pathStatus, observed] = await Promise.all([
      stat(leasePath, { bigint: true }),
      readLeaseOwner(leasePath),
    ]);
  } catch (error) {
    await handle.close();
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('INSTALL_LOCK_OWNERSHIP_LOST');
    throw error;
  }
  if (held.dev !== pathStatus.dev || held.ino !== pathStatus.ino
    || observed.token !== expected.token || observed.operationId !== expected.operationId
    || observed.pid !== expected.pid || observed.processIncarnation !== expected.processIncarnation) {
    await handle.close();
    throw new Error('INSTALL_LOCK_OWNERSHIP_LOST');
  }
  await rm(leasePath);
  await handle.close();
  await syncDirectory(lockDirectory);
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function readBootIdentity(
  platform: NodeJS.Platform,
  execute: ProcessIdentityCommandExecutor,
): Promise<string | undefined> {
  try {
    if (platform === 'darwin') {
      const { stdout } = await execute('/usr/sbin/sysctl', ['-n', 'kern.boottime'], {
        env: fixedProcessIdentityEnvironment,
      });
      const value = stdout.trim();
      return value.length === 0 ? undefined : `darwin:${value}`;
    }
    if (platform === 'linux') {
      const value = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
      return value.length === 0 ? undefined : `linux:${value}`;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

async function executeProcessIdentityCommand(
  executable: string,
  args: readonly string[],
  options: Readonly<{ env: Readonly<Record<string, string>> }>,
): Promise<Readonly<{ stdout: string }>> {
  const { stdout } = await execFileAsync(executable, [...args], {
    encoding: 'utf8',
    env: options.env,
  });
  return { stdout: String(stdout) };
}
function containsSecretField(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, nested]) => secretField.test(key) || containsSecretField(nested));
}
