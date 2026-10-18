import { mkdir, open, rename, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pathExists, syncDirectory } from './durable-filesystem';
import { recoverInterruptedInstall } from './recovery';
import type { InstallJournal, InstallPhase, ManagedPaths, PreviousInstallationState } from './types';
import type { ServiceIdentity, ServiceReleaseIdentity } from '../web/service-identity';

export type InstallTransactionInput = Readonly<{
  operationId: string;
  desiredReleaseId: string;
  previousInstallation: PreviousInstallationState;
  desiredService: 'running' | 'stopped';
  preserveData: boolean;
  requiredSnapshotBytes: number;
  paths: ManagedPaths;
}>;

export type InstallerTransactionDependencies = Readonly<{
  store: {
    lock(operationId: string): Promise<Readonly<{ release(): Promise<void> }>>;
    lockForRecovery(operationId: string): Promise<Readonly<{ release(): Promise<void> }>>;
    readJournal(): Promise<InstallJournal | undefined>;
    writeJournal(journal: InstallJournal): Promise<void>;
    clearJournal(operationId: string): Promise<void>;
  };
  release: {
    stage(input: Readonly<{ operationId: string; releaseId: string; paths: ManagedPaths }>): Promise<string>;
    verify(input: Readonly<{
      operationId: string;
      releaseId: string;
      stagedAppPath: string;
    }>): Promise<ServiceReleaseIdentity>;
    discard(input: Readonly<{ operationId: string; stagedAppPath?: string }>): Promise<void>;
  };
  maintenance: {
    acquire(input: Readonly<{ operationId: string; reason: 'upgrade' }>): Promise<Readonly<{ operationId: string }>>;
    commit(operationId: string): Promise<void>;
    rollback(operationId: string): Promise<void>;
  };
  snapshots: {
    create(input: Readonly<{ operationId: string; requiredBytes: number }>): Promise<unknown>;
    restore(operationId: string): Promise<void>;
    exists(operationId: string): Promise<boolean>;
  };
  application: {
    stageCurrent(input: Readonly<{ operationId: string; applicationPath: string; installerStatePath: string }>): Promise<void>;
    activate(input: Readonly<{ operationId: string; stagedAppPath: string; applicationPath: string }>): Promise<void>;
    rollback(input: Readonly<{ operationId: string; applicationPath: string; installerStatePath: string }>): Promise<void>;
    commit(input: Readonly<{ operationId: string; applicationPath: string; installerStatePath: string }>): Promise<void>;
  };
  launchAgent: {
    install(input: Readonly<{ operationId: string; paths: ManagedPaths; releaseId: string }>): Promise<void>;
    rollback(input: Readonly<{ operationId: string; paths: ManagedPaths }>): Promise<void>;
  };
  candidate: {
    start(input: Readonly<{ operationId: string; release: ServiceReleaseIdentity }>): Promise<void>;
    verify(input: Readonly<{ operationId: string; release: ServiceReleaseIdentity }>): Promise<ServiceIdentity>;
  };
  service: {
    restore(input: Readonly<{
      operationId: string;
      desiredService: 'running' | 'stopped';
      releaseId?: string;
    }>): Promise<void>;
    observe(input: Readonly<{ operationId: string }>): Promise<CanonicalServiceObservation>;
  };
  now(): Date;
}>;

export type InstallTransactionResult = Readonly<{
  kind: 'installed';
  operationId: string;
  releaseId: string;
}>;

export type CanonicalServiceObservation = ServiceIdentity | Readonly<{
  product: 'catbots';
  bundleId: 'com.catbots.desktop';
  state: 'stopped';
}>;

export type ApplicationActivationPlatform = Readonly<{
  exists(path: string): Promise<boolean>;
  ensureDirectory(path: string): Promise<void>;
  open(path: string, flags: 'wx', mode: number): Promise<Readonly<{
    writeFile(value: string, encoding: 'utf8'): Promise<unknown>;
    sync(): Promise<void>;
    close(): Promise<void>;
  }>>;
  rename(source: string, destination: string): Promise<void>;
  remove(path: string, options: Readonly<{ recursive?: boolean; force: true }>): Promise<void>;
  device(path: string): Promise<bigint>;
  syncDirectory(path: string): Promise<void>;
}>;

export type DirectoryCreationPlatform = Readonly<{
  stat(path: string): Promise<unknown>;
  mkdir(path: string): Promise<void>;
  syncDirectory(path: string): Promise<void>;
}>;

const nodeDirectoryCreationPlatform: DirectoryCreationPlatform = Object.freeze({
  stat,
  mkdir: async (path) => { await mkdir(path, { mode: 0o700 }); },
  syncDirectory,
});

export const nodeApplicationActivationPlatform: ApplicationActivationPlatform = Object.freeze({
  exists: pathExists,
  ensureDirectory: ensureDirectoryDurable,
  open: async (path, flags, mode) => open(path, flags, mode),
  rename,
  remove: async (path, options) => { await rm(path, options); },
  device: async (path) => BigInt((await stat(path)).dev),
  syncDirectory,
});

export class RenameApplicationActivator {
  constructor(private readonly platform: ApplicationActivationPlatform = nodeApplicationActivationPlatform) {}

  async stageCurrent(input: Readonly<{
    operationId: string;
    applicationPath: string;
    installerStatePath: string;
  }>): Promise<void> {
    assertOperationId(input.operationId);
    const backup = backupPath(input.applicationPath, input.operationId);
    if (await this.platform.exists(backup)) {
      if (await this.platform.exists(input.applicationPath)) throw new Error('INSTALL_APPLICATION_BACKUP_CONFLICT');
      return;
    }
    if (!await this.platform.exists(input.applicationPath)) {
      await writeAbsenceMarker(input.applicationPath, input.operationId, this.platform);
      return;
    }
    await this.platform.rename(input.applicationPath, backup);
    await this.platform.syncDirectory(dirname(input.applicationPath));
  }

  async activate(input: Readonly<{
    operationId: string;
    stagedAppPath: string;
    applicationPath: string;
  }>): Promise<void> {
    assertOperationId(input.operationId);
    await this.platform.ensureDirectory(dirname(input.applicationPath));
    const [stagedParent, applicationParent] = await Promise.all([
      this.platform.device(dirname(input.stagedAppPath)),
      this.platform.device(dirname(input.applicationPath)),
    ]);
    if (stagedParent !== applicationParent) throw new Error('INSTALL_ACTIVATION_VOLUME_MISMATCH');
    await this.platform.rename(input.stagedAppPath, input.applicationPath);
    for (const parent of new Set([dirname(input.stagedAppPath), dirname(input.applicationPath)])) {
      await this.platform.syncDirectory(parent);
    }
  }

  async rollback(input: Readonly<{
    operationId: string;
    applicationPath: string;
    installerStatePath: string;
  }>): Promise<void> {
    assertOperationId(input.operationId);
    const backup = backupPath(input.applicationPath, input.operationId);
    const failed = failedPath(input.applicationPath, input.operationId);
    if (await this.platform.exists(backup)) {
      if (await this.platform.exists(input.applicationPath)) {
        await this.platform.remove(failed, { recursive: true, force: true });
        await this.platform.rename(input.applicationPath, failed);
      }
      await this.platform.rename(backup, input.applicationPath);
      await this.platform.syncDirectory(dirname(input.applicationPath));
      await this.platform.remove(failed, { recursive: true, force: true });
      return;
    }
    const marker = absenceMarkerPath(input.applicationPath, input.operationId);
    if (await this.platform.exists(marker)) {
      await this.platform.remove(input.applicationPath, { recursive: true, force: true });
      await this.platform.remove(marker, { force: true });
      await this.platform.syncDirectory(dirname(input.applicationPath));
    }
  }

  async commit(input: Readonly<{
    operationId: string;
    applicationPath: string;
    installerStatePath: string;
  }>): Promise<void> {
    assertOperationId(input.operationId);
    await this.platform.remove(backupPath(input.applicationPath, input.operationId), { recursive: true, force: true });
    await this.platform.remove(failedPath(input.applicationPath, input.operationId), { recursive: true, force: true });
    await this.platform.remove(absenceMarkerPath(input.applicationPath, input.operationId), { force: true });
    await this.platform.syncDirectory(dirname(input.applicationPath));
  }
}

export async function runInstallTransaction(
  input: InstallTransactionInput,
  dependencies: InstallerTransactionDependencies,
): Promise<InstallTransactionResult> {
  await recoverInterruptedInstall(dependencies);
  return executeInstallTransaction(input, dependencies);
}

export async function executeInstallTransaction(
  input: InstallTransactionInput,
  dependencies: InstallerTransactionDependencies,
): Promise<InstallTransactionResult> {
  const lock = await dependencies.store.lock(input.operationId);
  let journal: InstallJournal | undefined;
  let stagedAppPath: string | undefined;
  let leaseAcquired = false;
  try {
    if (await dependencies.store.readJournal() !== undefined) throw new Error('INSTALL_RECOVERY_REQUIRED');
    const createdAt = dependencies.now().toISOString();
    journal = {
      schemaVersion: 1,
      operationId: input.operationId,
      phase: 'prepared',
      desiredReleaseId: input.desiredReleaseId,
      previousInstallation: input.previousInstallation,
      desiredService: input.desiredService,
      preserveData: input.preserveData,
      paths: input.paths,
      createdAt,
      updatedAt: createdAt,
    };
    const advance = async (phase: InstallPhase): Promise<void> => {
      if (journal === undefined) throw new Error('INSTALL_JOURNAL_MISSING');
      journal = { ...journal, phase, updatedAt: dependencies.now().toISOString() };
      await dependencies.store.writeJournal(journal);
    };

    if (journal === undefined) throw new Error('INSTALL_JOURNAL_MISSING');
    await dependencies.store.writeJournal(journal);
    stagedAppPath = await dependencies.release.stage({
      operationId: input.operationId,
      releaseId: input.desiredReleaseId,
      paths: input.paths,
    });
    const releaseIdentity = await dependencies.release.verify({
      operationId: input.operationId,
      releaseId: input.desiredReleaseId,
      stagedAppPath,
    });
    assertReleaseIdentity(releaseIdentity, input.desiredReleaseId);
    await advance('release-verified');
    await advance('maintenance-prepared');
    const lease = await dependencies.maintenance.acquire({ operationId: input.operationId, reason: 'upgrade' });
    if (lease.operationId !== input.operationId) throw new Error('MAINTENANCE_LEASE_MISMATCH');
    leaseAcquired = true;
    await advance('data-snapshotted');
    await dependencies.snapshots.create({ operationId: input.operationId, requiredBytes: input.requiredSnapshotBytes });
    await advance('old-app-staged');
    await dependencies.application.stageCurrent({
      operationId: input.operationId,
      applicationPath: input.paths.application,
      installerStatePath: input.paths.installerState,
    });
    await advance('new-app-installed');
    await dependencies.application.activate({
      operationId: input.operationId,
      stagedAppPath,
      applicationPath: input.paths.application,
    });
    await advance('launch-agent-written');
    await dependencies.launchAgent.install({
      operationId: input.operationId,
      paths: input.paths,
      releaseId: input.desiredReleaseId,
    });
    await advance('candidate-verifying');
    await dependencies.candidate.start({ operationId: input.operationId, release: releaseIdentity });
    const candidateHealth = await dependencies.candidate.verify({
      operationId: input.operationId,
      release: releaseIdentity,
    });
    assertCandidateHealth(candidateHealth, input.operationId, releaseIdentity);
    await dependencies.service.restore({
      operationId: input.operationId,
      desiredService: input.desiredService,
      releaseId: input.desiredReleaseId,
    });
    const canonicalHealth = await dependencies.service.observe({ operationId: input.operationId });
    assertCanonicalService(canonicalHealth, input.desiredService, releaseIdentity);
    await advance('committed');
    await dependencies.maintenance.commit(input.operationId);
    await dependencies.application.commit({
      operationId: input.operationId,
      applicationPath: input.paths.application,
      installerStatePath: input.paths.installerState,
    });
    await advance('complete');
    return { kind: 'installed', operationId: input.operationId, releaseId: input.desiredReleaseId };
  } catch (error) {
    if (journal !== undefined && leaseAcquired && journal.phase !== 'committed' && journal.phase !== 'complete') {
      await rollbackFailedInstall(journal, stagedAppPath, dependencies, error);
    } else if (journal !== undefined && ['prepared', 'release-verified'].includes(journal.phase)) {
      await discardFailedStage(journal, stagedAppPath, dependencies, error);
    }
    throw error;
  } finally {
    await lock.release();
  }
}

async function discardFailedStage(
  journal: InstallJournal,
  stagedAppPath: string | undefined,
  dependencies: InstallerTransactionDependencies,
  originalError: unknown,
): Promise<void> {
  const rollingBack: InstallJournal = {
    ...journal,
    phase: 'rolling-back',
    rollbackFromPhase: journal.phase,
    updatedAt: dependencies.now().toISOString(),
  };
  await dependencies.store.writeJournal(rollingBack);
  try {
    await dependencies.release.discard({ operationId: journal.operationId, stagedAppPath });
  } catch (cleanupError) {
    throw new AggregateError([originalError, cleanupError], 'INSTALL_ROLLBACK_FAILED');
  }
  await dependencies.store.writeJournal({
    ...rollingBack,
    phase: 'rolled-back',
    updatedAt: dependencies.now().toISOString(),
  });
}

async function rollbackFailedInstall(
  journal: InstallJournal,
  stagedAppPath: string | undefined,
  dependencies: InstallerTransactionDependencies,
  originalError: unknown,
): Promise<void> {
  const rollingBack = {
    ...journal,
    phase: 'rolling-back' as const,
    rollbackFromPhase: journal.phase,
    updatedAt: dependencies.now().toISOString(),
  };
  await dependencies.store.writeJournal(rollingBack);
  const failures: unknown[] = [];
  const attempt = async (action: () => Promise<void>) => {
    try {
      await action();
    } catch (error) {
      failures.push(error);
    }
  };
  await attempt(() => dependencies.launchAgent.rollback({ operationId: journal.operationId, paths: journal.paths }));
  await attempt(() => dependencies.application.rollback({
    operationId: journal.operationId,
    applicationPath: journal.paths.application,
    installerStatePath: journal.paths.installerState,
  }));
  let snapshotExists = false;
  await attempt(async () => { snapshotExists = await dependencies.snapshots.exists(journal.operationId); });
  if (snapshotExists) await attempt(() => dependencies.snapshots.restore(journal.operationId));
  await attempt(() => dependencies.release.discard({ operationId: journal.operationId, stagedAppPath }));
  await attempt(() => dependencies.service.restore(previousServiceRestore(journal)));
  await attempt(() => dependencies.maintenance.rollback(journal.operationId));
  if (failures.length > 0) throw new AggregateError([originalError, ...failures], 'INSTALL_ROLLBACK_FAILED');
  await dependencies.store.writeJournal({
    ...rollingBack,
    phase: 'rolled-back',
    updatedAt: dependencies.now().toISOString(),
  });
}

function assertCandidateHealth(
  health: ServiceIdentity,
  operationId: string,
  release: ServiceReleaseIdentity,
): void {
  if (Object.keys(health).sort().join(',') !== candidateIdentityKeys
    || health.readiness !== 'maintenance'
    || health.maintenanceOperationId !== operationId
    || !releaseIdentityMatches(health, release)) {
    throw new Error('CANDIDATE_HEALTH_IDENTITY_MISMATCH');
  }
}

function assertCanonicalService(
  observed: CanonicalServiceObservation,
  desiredService: 'running' | 'stopped',
  release: ServiceReleaseIdentity,
): void {
  if (desiredService === 'stopped') {
    if (Object.keys(observed).sort().join(',') !== stoppedIdentityKeys
      || !('state' in observed) || observed.product !== 'catbots'
      || observed.bundleId !== 'com.catbots.desktop' || observed.state !== 'stopped') {
      throw new Error('CANONICAL_STOPPED_STATE_MISMATCH');
    }
    return;
  }
  if (Object.keys(observed).sort().join(',') !== canonicalIdentityKeys
    || 'state' in observed || observed.readiness !== 'ready'
    || observed.maintenanceOperationId !== undefined
    || !releaseIdentityMatches(observed, release)) {
    throw new Error('CANONICAL_HEALTH_IDENTITY_MISMATCH');
  }
}

function assertReleaseIdentity(identity: ServiceReleaseIdentity, releaseId: string): void {
  if (Object.keys(identity).sort().join(',') !== releaseIdentityKeys
    || identity.releaseId !== releaseId
    || identity.product !== 'catbots'
    || identity.bundleId !== 'com.catbots.desktop'
    || identity.resumePolicy !== 'manual-only') {
    throw new Error('VERIFIED_RELEASE_IDENTITY_MISMATCH');
  }
}

function releaseIdentityMatches(
  observed: ServiceIdentity,
  release: ServiceReleaseIdentity,
): boolean {
  return releaseIdentityProperties.every((key) => observed[key] === release[key]);
}

const releaseIdentityProperties = [
  'product',
  'bundleId',
  'releaseId',
  'version',
  'commit',
  'architecture',
  'protocolVersion',
  'dataSchemaVersion',
  'resumePolicy',
] as const satisfies readonly (keyof ServiceReleaseIdentity)[];
const releaseIdentityKeys = [...releaseIdentityProperties].sort().join(',');
const candidateIdentityKeys = [...releaseIdentityProperties, 'instanceId', 'readiness', 'maintenanceOperationId']
  .sort().join(',');
const canonicalIdentityKeys = [...releaseIdentityProperties, 'instanceId', 'readiness'].sort().join(',');
const stoppedIdentityKeys = ['bundleId', 'product', 'state'].sort().join(',');

export function previousServiceRestore(journal: Pick<InstallJournal, 'operationId' | 'previousInstallation'>): Readonly<{
  operationId: string;
  desiredService: 'running' | 'stopped';
  releaseId?: string;
}> {
  return journal.previousInstallation.kind === 'absent'
    ? { operationId: journal.operationId, desiredService: 'stopped' }
    : {
        operationId: journal.operationId,
        desiredService: journal.previousInstallation.desiredService,
        releaseId: journal.previousInstallation.releaseId,
      };
}

const operationIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/;

function assertOperationId(operationId: string): void {
  if (!operationIdPattern.test(operationId)) throw new Error('INSTALL_OPERATION_ID_INVALID');
}

function backupPath(applicationPath: string, operationId: string): string {
  return `${applicationPath}.rollback-${operationId}`;
}

function failedPath(applicationPath: string, operationId: string): string {
  return `${applicationPath}.failed-${operationId}`;
}

function absenceMarkerPath(applicationPath: string, operationId: string): string {
  return `${applicationPath}.absent-${operationId}`;
}

async function writeAbsenceMarker(
  applicationPath: string,
  operationId: string,
  platform: ApplicationActivationPlatform,
): Promise<void> {
  const marker = absenceMarkerPath(applicationPath, operationId);
  if (await platform.exists(marker)) return;
  await platform.ensureDirectory(dirname(applicationPath));
  const handle = await platform.open(marker, 'wx', 0o600);
  try {
    await handle.writeFile(`${operationId}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await platform.syncDirectory(dirname(applicationPath));
}

export async function ensureDirectoryDurable(
  directory: string,
  platform: DirectoryCreationPlatform = nodeDirectoryCreationPlatform,
): Promise<void> {
  const missing: string[] = [];
  let current = directory;
  while (true) {
    try {
      await platform.stat(current);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      missing.push(current);
      const parent = dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
  for (const path of missing.reverse()) {
    try {
      await platform.mkdir(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    await platform.syncDirectory(dirname(path));
  }
}
