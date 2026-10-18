import { execFile } from 'node:child_process';
import { lstat, mkdir, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { ControlCommand } from '../application/process-intent';
import { serviceReleaseMatches, type ServiceIdentity, type ServiceReleaseIdentity } from '../web/service-identity';
import { InstallStore } from './install-store';
import { resolveManagedPaths } from './managed-paths';
import type { ManagedPaths } from './types';

export const purgeConfirmation = 'PURGE CATBOTS DATA';

type MaintenanceBlocker = Readonly<{
  kind: string;
  route: string;
  [key: string]: unknown;
}>;

type MaintenanceDecision =
  | Readonly<{
      kind: 'ready';
      lease: Readonly<{ operationId: string; reason: 'uninstall' }>;
    }>
  | Readonly<{ kind: 'blocked'; blockers: readonly MaintenanceBlocker[] }>;

export type UninstallRequest = Readonly<{
  operationId: string;
  paths: ManagedPaths;
  purgeData: boolean;
}>;

export type UninstallOutcome =
  | Readonly<{ kind: 'blocked'; blockers: readonly MaintenanceBlocker[] }>
  | Readonly<{
      kind: 'uninstalled' | 'purged';
      operationId: string;
      dataPreserved: boolean;
    }>;

export type UninstallDeletionRecord = Readonly<{
  schemaVersion: 1;
  operationId: string;
  kind: 'delete';
  path: string;
  recursive: boolean;
  quarantinePath: string;
  phase: 'prepared' | 'quarantined' | 'complete';
  identity: PathIdentity;
  recordedAt: string;
}>;

type PathIdentity = Readonly<{
  dev: number;
  ino: number;
  uid: number;
  directory: boolean;
  file: boolean;
}>;

type PathStatus = Readonly<{
  isSymbolicLink(): boolean;
  isDirectory(): boolean;
  isFile(): boolean;
  uid: number;
  mode: number;
  dev: number;
  ino: number;
}>;

export type UninstallDependencies = Readonly<{
  maintenance: {
    begin(request: Readonly<{ operationId: string; reason: 'uninstall' }>): Promise<MaintenanceDecision>;
    commit(operationId: string): Promise<void>;
    rollback(operationId: string): Promise<void>;
  };
  launchAgent: {
    stop(): Promise<void>;
  };
  store: {
    lockForUninstall(operationId: string): Promise<Readonly<{ release(): Promise<void> }>>;
    recordDeletion(record: UninstallDeletionRecord): Promise<void>;
    readDeletionJournal(): Promise<readonly UninstallDeletionRecord[]>;
  };
  confirmation: {
    isInteractive(): boolean;
    read(prompt: string): Promise<string>;
  };
  filesystem?: {
    lstat(path: string): Promise<PathStatus>;
    remove(path: string, options: Readonly<{ recursive: boolean; force: true }>): Promise<void>;
    mkdir?(path: string): Promise<void>;
    rename?(source: string, destination: string): Promise<void>;
    beforeQuarantineRemoval?(directory: string, name: string): Promise<void>;
  };
  now?: () => Date;
}>;

export type InstalledUninstallerOptions = Readonly<{
  homeDirectory: string;
  uid: number;
  operationId(): string;
  confirmation: UninstallDependencies['confirmation'];
  health: { current(): Promise<ServiceIdentity | undefined> };
  expectedRelease: ServiceReleaseIdentity;
  socketPath: string;
  createControl(options: Readonly<{
    socketPath: string;
    expectedInstanceId: string;
  }>): Readonly<{ execute(command: ControlCommand): Promise<unknown> }>;
  launchAgent(paths: ManagedPaths): UninstallDependencies['launchAgent'] & Readonly<{
    status(): Promise<Readonly<{ loaded: boolean }>>;
  }>;
}>;

const nodeFilesystem = Object.freeze({
  lstat: async (path: string): Promise<PathStatus> => lstat(path),
  remove: async (path: string, options: Readonly<{ recursive: boolean; force: true }>) => {
    await rm(path, options);
  },
  mkdir: async (path: string) => { await mkdir(path, { recursive: true, mode: 0o700 }); },
  rename,
});

const execFileAsync = promisify(execFile);

export function createInstalledUninstaller(
  options: InstalledUninstallerOptions,
): (purgeData: boolean) => Promise<UninstallOutcome> {
  return async (purgeData) => {
    const operationId = options.operationId();
    const paths = await resolveManagedPaths(options.homeDirectory, options.uid);
    const launchAgent = options.launchAgent(paths);
    let control: Readonly<{ execute(command: ControlCommand): Promise<unknown> }> | undefined;
    let shutdownRequested = false;
    const maintenance: UninstallDependencies['maintenance'] = {
      begin: async (request) => {
        const [agent, identity] = await Promise.all([
          launchAgent.status(),
          options.health.current(),
        ]);
        if (identity === undefined) {
          if (agent.loaded) throw new Error('SERVICE_HEALTH_UNAVAILABLE');
          return { kind: 'ready', lease: request };
        }
        if (!serviceReleaseMatches(identity, options.expectedRelease) || identity.readiness !== 'ready') {
          throw new Error('SERVICE_IDENTITY_MISMATCH');
        }
        control = options.createControl({
          socketPath: options.socketPath,
          expectedInstanceId: identity.instanceId,
        });
        return parseUninstallMaintenanceDecision(await control.execute({
          kind: 'prepare-maintenance',
          operationId: request.operationId,
          reason: 'uninstall',
        }));
      },
      commit: async () => undefined,
      rollback: async (leaseId) => {
        if (control !== undefined && !shutdownRequested) {
          await control.execute({ kind: 'cancel-maintenance', leaseId });
        }
      },
    };
    return uninstall({ operationId, paths, purgeData }, {
      maintenance,
      launchAgent: {
        stop: async () => {
          if (control !== undefined) {
            await control.execute({ kind: 'shutdown', leaseId: operationId });
            shutdownRequested = true;
          }
          await launchAgent.stop();
        },
      },
      store: new InstallStore(paths.installerState),
      confirmation: options.confirmation,
    });
  };
}

export async function uninstall(
  request: UninstallRequest,
  dependencies: UninstallDependencies,
): Promise<UninstallOutcome> {
  const filesystem = dependencies.filesystem ?? nodeFilesystem;
  const now = dependencies.now ?? (() => new Date());
  assertOperationId(request.operationId);
  assertManagedPathNames(request.paths);
  const lock = await dependencies.store.lockForUninstall(request.operationId);
  try {
    await inspectManagedPaths(request.paths, filesystem);
    await recoverInterruptedDeletions(request.paths, dependencies, filesystem, now);

    if (request.purgeData) {
      if (!dependencies.confirmation.isInteractive()) {
        throw new Error('PURGE_REQUIRES_INTERACTIVE_CONFIRMATION');
      }
      if (await dependencies.confirmation.read(
        `Type ${purgeConfirmation} to permanently delete Catbots data: `,
      ) !== purgeConfirmation) {
        throw new Error('PURGE_CONFIRMATION_MISMATCH');
      }
    }

    const decision = await dependencies.maintenance.begin({
      operationId: request.operationId,
      reason: 'uninstall',
    });
    if (decision.kind === 'blocked') return decision;
    if (decision.lease.operationId !== request.operationId || decision.lease.reason !== 'uninstall') {
      throw new Error('MAINTENANCE_LEASE_MISMATCH');
    }
    try {
      await dependencies.launchAgent.stop();
      const quarantine = await prepareQuarantine(request, filesystem);
      const deletions = [
        { path: request.paths.application, recursive: true, name: 'application' },
        { path: request.paths.command, recursive: false, name: 'command' },
        { path: request.paths.launchAgent, recursive: false, name: 'launch-agent' },
        ...(request.purgeData
          ? [{ path: request.paths.productData, recursive: true, name: 'product-data' }]
          : []),
      ] as const;
      for (const deletion of deletions) {
        await quarantineManagedPath(request, deletion, quarantine, dependencies, filesystem, now);
      }
      await dependencies.maintenance.commit(request.operationId);
      return {
        kind: request.purgeData ? 'purged' : 'uninstalled',
        operationId: request.operationId,
        dataPreserved: !request.purgeData,
      };
    } catch (error) {
      try {
        await dependencies.maintenance.rollback(request.operationId);
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], 'UNINSTALL_ROLLBACK_FAILED');
      }
      throw error;
    }
  } finally {
    await lock.release();
  }
}

async function prepareQuarantine(
  request: UninstallRequest,
  filesystem: NonNullable<UninstallDependencies['filesystem']>,
): Promise<Readonly<{ path: string; status: PathStatus }>> {
  const root = join(request.paths.installerState, 'uninstall-quarantine');
  const path = join(root, request.operationId);
  await (filesystem.mkdir ?? nodeFilesystem.mkdir)(path);
  const expectedUid = await inspectHome(request.paths.home, filesystem);
  await inspectPathChain(path, request.paths.home, expectedUid, filesystem);
  const status = await filesystem.lstat(path);
  if (!status.isDirectory() || status.isSymbolicLink()) throw new Error('UNSAFE_MANAGED_PATH');
  return { path, status };
}

async function quarantineManagedPath(
  request: UninstallRequest,
  deletion: Readonly<{ path: string; recursive: boolean; name: string }>,
  quarantine: Readonly<{ path: string; status: PathStatus }>,
  dependencies: UninstallDependencies,
  filesystem: NonNullable<UninstallDependencies['filesystem']>,
  now: () => Date,
): Promise<void> {
  const target = await inspectExistingTarget(deletion.path, request.paths.home, filesystem);
  if (target === undefined) return;
  if (target.dev !== quarantine.status.dev) throw new Error('UNINSTALL_QUARANTINE_VOLUME_MISMATCH');
  const parentSnapshots = await snapshotPathChain(dirname(deletion.path), request.paths.home, filesystem);
  const quarantinePath = join(quarantine.path, deletion.name);
  await dependencies.store.recordDeletion({
    schemaVersion: 1,
    operationId: request.operationId,
    kind: 'delete',
    path: deletion.path,
    recursive: deletion.recursive,
    quarantinePath,
    phase: 'prepared',
    identity: identityOf(target),
    recordedAt: now().toISOString(),
  });
  await (filesystem.rename ?? nodeFilesystem.rename)(deletion.path, quarantinePath);
  let safe = false;
  try {
    const moved = await filesystem.lstat(quarantinePath);
    safe = sameIdentity(target, moved)
      && sameIdentity(quarantine.status, await filesystem.lstat(quarantine.path))
      && await pathChainMatches(parentSnapshots, filesystem);
  } catch {
    safe = false;
  }
  if (!safe) {
    try {
      await (filesystem.rename ?? nodeFilesystem.rename)(quarantinePath, deletion.path);
    } catch (rollbackError) {
      throw new AggregateError([new Error('UNSAFE_MANAGED_PATH'), rollbackError], 'UNINSTALL_QUARANTINE_ROLLBACK_FAILED');
    }
    throw new Error('UNSAFE_MANAGED_PATH');
  }
  await dependencies.store.recordDeletion({
    schemaVersion: 1,
    operationId: request.operationId,
    kind: 'delete',
    path: deletion.path,
    recursive: deletion.recursive,
    quarantinePath,
    phase: 'quarantined',
    identity: identityOf(target),
    recordedAt: now().toISOString(),
  });
  await removeQuarantineEntry(quarantine.path, deletion.name, target, filesystem);
  await dependencies.store.recordDeletion({
    schemaVersion: 1,
    operationId: request.operationId,
    kind: 'delete',
    path: deletion.path,
    recursive: deletion.recursive,
    quarantinePath,
    phase: 'complete',
    identity: identityOf(target),
    recordedAt: now().toISOString(),
  });
}

async function recoverInterruptedDeletions(
  paths: ManagedPaths,
  dependencies: UninstallDependencies,
  filesystem: NonNullable<UninstallDependencies['filesystem']>,
  now: () => Date,
): Promise<void> {
  const latest = new Map<string, UninstallDeletionRecord>();
  for (const record of await dependencies.store.readDeletionJournal()) {
    assertDeletionRecordPaths(record, paths);
    latest.set(`${record.operationId}\0${record.path}`, record);
  }
  for (const record of latest.values()) {
    if (record.phase === 'complete') continue;
    let source = await inspectExistingTarget(record.path, paths.home, filesystem);
    let quarantined = await inspectExistingTarget(record.quarantinePath, paths.home, filesystem);
    if (source !== undefined && quarantined !== undefined) throw new Error('UNSAFE_UNINSTALL_RECOVERY');
    if (source !== undefined && !sameRecordedIdentity(record.identity, source)) {
      throw new Error('UNSAFE_UNINSTALL_RECOVERY');
    }
    if (quarantined !== undefined && !sameRecordedIdentity(record.identity, quarantined)) {
      throw new Error('UNSAFE_UNINSTALL_RECOVERY');
    }
    if (record.phase === 'quarantined' && source !== undefined) {
      throw new Error('UNSAFE_UNINSTALL_RECOVERY');
    }
    if (record.phase === 'prepared' && source !== undefined) {
      await dependencies.store.recordDeletion({
        ...record,
        phase: 'complete',
        recordedAt: now().toISOString(),
      });
      continue;
    }
    if (quarantined !== undefined) {
      await removeQuarantineEntry(
        dirname(record.quarantinePath),
        record.quarantinePath.slice(dirname(record.quarantinePath).length + 1),
        quarantined,
        filesystem,
      );
    }
    await dependencies.store.recordDeletion({
      ...record,
      phase: 'complete',
      recordedAt: now().toISOString(),
    });
  }
}

async function removeQuarantineEntry(
  directory: string,
  name: string,
  expected: PathStatus,
  filesystem: NonNullable<UninstallDependencies['filesystem']>,
): Promise<void> {
  if (name.includes('/') || name === '.' || name === '..') throw new Error('UNSAFE_MANAGED_PATH');
  const target = join(directory, name);
  await filesystem.beforeQuarantineRemoval?.(directory, name);
  await removeVerifiedFileReference(target, identityOf(expected));
}

async function removeVerifiedFileReference(path: string, expected: PathIdentity): Promise<void> {
  const expectedType = expected.directory
    ? 'NSFileTypeDirectory'
    : expected.file ? 'NSFileTypeRegular' : undefined;
  if (expectedType === undefined) throw new Error('UNSAFE_UNINSTALL_FILE_REFERENCE');
  const script = [
    'ObjC.import("Foundation");',
    'const environment = $.NSProcessInfo.processInfo.environment;',
    'const path = ObjC.unwrap(environment.objectForKey("CATBOTS_QUARANTINE_TARGET"));',
    'const reference = $.NSURL.fileURLWithPath(path).fileReferenceURL;',
    'const error = Ref();',
    'const manager = $.NSFileManager.defaultManager;',
    'const attributes = manager.attributesOfItemAtPathError(reference.path, error);',
    'if (!attributes) throw new Error(ObjC.unwrap(error[0].localizedDescription));',
    'const actual = {',
    '  dev: Number(attributes.objectForKey($.NSFileSystemNumber).unsignedLongLongValue),',
    '  ino: Number(attributes.objectForKey($.NSFileSystemFileNumber).unsignedLongLongValue),',
    '  uid: Number(attributes.objectForKey($.NSFileOwnerAccountID).unsignedLongLongValue),',
    '  type: ObjC.unwrap(attributes.objectForKey($.NSFileType)),',
    '};',
    'const matches = actual.dev === Number(ObjC.unwrap(environment.objectForKey("CATBOTS_EXPECTED_DEV")))',
    '  && actual.ino === Number(ObjC.unwrap(environment.objectForKey("CATBOTS_EXPECTED_INO")))',
    '  && actual.uid === Number(ObjC.unwrap(environment.objectForKey("CATBOTS_EXPECTED_UID")))',
    '  && actual.type === ObjC.unwrap(environment.objectForKey("CATBOTS_EXPECTED_TYPE"));',
    'if (!matches) JSON.stringify({ kind: "identity-mismatch" });',
    'else {',
    '  const removalError = Ref();',
    '  if (!manager.removeItemAtURLError(reference, removalError))',
    '    throw new Error(ObjC.unwrap(removalError[0].localizedDescription));',
    '  JSON.stringify({ kind: "removed", identity: actual });',
    '}',
  ].join(' ');
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script], {
      env: {
        ...process.env,
        CATBOTS_QUARANTINE_TARGET: path,
        CATBOTS_EXPECTED_DEV: String(expected.dev),
        CATBOTS_EXPECTED_INO: String(expected.ino),
        CATBOTS_EXPECTED_UID: String(expected.uid),
        CATBOTS_EXPECTED_TYPE: expectedType,
      },
    }));
  } catch {
    throw new Error('UNSAFE_UNINSTALL_FILE_REFERENCE');
  }
  try {
    const result = JSON.parse(stdout) as {
      kind?: unknown;
      identity?: { dev?: unknown; ino?: unknown; uid?: unknown; type?: unknown };
    };
    if (result.kind !== 'removed' || result.identity?.dev !== expected.dev
      || result.identity.ino !== expected.ino || result.identity.uid !== expected.uid
      || result.identity.type !== expectedType) {
      throw new Error('UNSAFE_UNINSTALL_FILE_REFERENCE');
    }
  } catch {
    throw new Error('UNSAFE_UNINSTALL_FILE_REFERENCE');
  }
}

function assertDeletionRecordPaths(record: UninstallDeletionRecord, paths: ManagedPaths): void {
  assertOperationId(record.operationId);
  const names = new Map<string, string>([
    [paths.application, 'application'],
    [paths.command, 'command'],
    [paths.launchAgent, 'launch-agent'],
    [paths.productData, 'product-data'],
  ]);
  const name = names.get(record.path);
  if (name === undefined || record.quarantinePath !== join(
    paths.installerState,
    'uninstall-quarantine',
    record.operationId,
    name,
  )) throw new Error('UNSAFE_UNINSTALL_RECOVERY');
}

function identityOf(status: PathStatus): PathIdentity {
  return {
    dev: status.dev,
    ino: status.ino,
    uid: status.uid,
    directory: status.isDirectory(),
    file: status.isFile(),
  };
}

function sameRecordedIdentity(identity: PathIdentity, status: PathStatus): boolean {
  return identity.dev === status.dev && identity.ino === status.ino && identity.uid === status.uid
    && identity.directory === status.isDirectory() && identity.file === status.isFile();
}

function assertManagedPathNames(paths: ManagedPaths): void {
  const home = resolve(paths.home);
  const expected: ManagedPaths = {
    home,
    application: join(home, 'Applications', 'Catbots.app'),
    command: join(home, '.local', 'bin', 'catbots'),
    launchAgent: join(home, 'Library', 'LaunchAgents', 'fun.catbots.web.plist'),
    installerState: join(home, 'Library', 'Application Support', 'Catbots Installer'),
    productData: join(home, 'Library', 'Application Support', 'Catbots'),
  };
  if (!isAbsolute(paths.home) || paths.home !== home
    || Object.keys(expected).some((key) => paths[key as keyof ManagedPaths] !== expected[key as keyof ManagedPaths])) {
    throw new Error('UNSAFE_MANAGED_PATH');
  }
}

async function inspectManagedPaths(
  paths: ManagedPaths,
  filesystem: NonNullable<UninstallDependencies['filesystem']>,
): Promise<void> {
  const expectedUid = await inspectHome(paths.home, filesystem);
  for (const path of Object.values(paths).slice(1)) {
    await inspectPathChain(path, paths.home, expectedUid, filesystem);
  }
}

async function pathExistsWithoutSymlink(
  path: string,
  home: string,
  filesystem: NonNullable<UninstallDependencies['filesystem']>,
): Promise<boolean> {
  const expectedUid = await inspectHome(home, filesystem);
  return inspectPathChain(path, home, expectedUid, filesystem);
}

async function inspectExistingTarget(
  path: string,
  home: string,
  filesystem: NonNullable<UninstallDependencies['filesystem']>,
): Promise<PathStatus | undefined> {
  if (!await pathExistsWithoutSymlink(path, home, filesystem)) return undefined;
  return filesystem.lstat(path);
}

type PathSnapshot = Readonly<{ path: string; status: PathStatus }>;

async function snapshotPathChain(
  target: string,
  home: string,
  filesystem: NonNullable<UninstallDependencies['filesystem']>,
): Promise<readonly PathSnapshot[]> {
  const relation = relative(home, target);
  if (relation.startsWith('..') || isAbsolute(relation)) throw new Error('UNSAFE_MANAGED_PATH');
  const snapshots: PathSnapshot[] = [];
  let current = home;
  snapshots.push({ path: current, status: await filesystem.lstat(current) });
  for (const segment of relation.split('/').filter(Boolean)) {
    current = join(current, segment);
    snapshots.push({ path: current, status: await filesystem.lstat(current) });
  }
  return snapshots;
}

async function pathChainMatches(
  snapshots: readonly PathSnapshot[],
  filesystem: NonNullable<UninstallDependencies['filesystem']>,
): Promise<boolean> {
  for (const snapshot of snapshots) {
    const current = await filesystem.lstat(snapshot.path);
    if (current.isSymbolicLink() || !sameIdentity(snapshot.status, current)) return false;
  }
  return true;
}

function sameIdentity(left: PathStatus, right: PathStatus): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.uid === right.uid
    && left.isDirectory() === right.isDirectory() && left.isFile() === right.isFile();
}

async function inspectPathChain(
  target: string,
  home: string,
  expectedUid: number,
  filesystem: NonNullable<UninstallDependencies['filesystem']>,
): Promise<boolean> {
  const relation = relative(home, target);
  if (relation.startsWith('..') || isAbsolute(relation)) throw new Error('UNSAFE_MANAGED_PATH');
  const segments = relation.split('/').filter(Boolean);
  let current = home;
  let targetExists = true;
  for (const segment of segments) {
    current = join(current, segment);
    try {
      const status = await filesystem.lstat(current);
      if (status.isSymbolicLink() || status.uid !== expectedUid || (status.mode & 0o022) !== 0) {
        throw new Error('UNSAFE_MANAGED_PATH');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      targetExists = false;
      break;
    }
  }
  return targetExists;
}

async function inspectHome(
  home: string,
  filesystem: NonNullable<UninstallDependencies['filesystem']>,
): Promise<number> {
  try {
    const status = await filesystem.lstat(home);
    if (status.isSymbolicLink() || !Number.isSafeInteger(status.uid) || status.uid < 0
      || (status.mode & 0o022) !== 0) {
      throw new Error('UNSAFE_MANAGED_PATH');
    }
    return status.uid;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('UNSAFE_MANAGED_PATH');
    throw error;
  }
}

function assertOperationId(operationId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/.test(operationId)) {
    throw new Error('UNINSTALL_OPERATION_ID_INVALID');
  }
}

function parseUninstallMaintenanceDecision(value: unknown): MaintenanceDecision {
  if (value === null || typeof value !== 'object') throw new Error('MAINTENANCE_RESPONSE_INVALID');
  const candidate = value as {
    kind?: unknown;
    blockers?: unknown;
    lease?: { operationId?: unknown; reason?: unknown };
  };
  if (candidate.kind === 'blocked' && Array.isArray(candidate.blockers)) {
    return { kind: 'blocked', blockers: candidate.blockers as readonly MaintenanceBlocker[] };
  }
  if (candidate.kind === 'ready' && typeof candidate.lease?.operationId === 'string'
    && candidate.lease.reason === 'uninstall') {
    return {
      kind: 'ready',
      lease: { operationId: candidate.lease.operationId, reason: 'uninstall' },
    };
  }
  throw new Error('MAINTENANCE_RESPONSE_INVALID');
}
