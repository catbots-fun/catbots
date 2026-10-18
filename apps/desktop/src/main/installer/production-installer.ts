import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, copyFile, lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import type { App } from 'electron';
import { InstallStore } from './install-store';
import { RenameApplicationActivator, type InstallTransactionInput } from './install-transaction';
import type { BootstrapInstallRequest, InstallerDependencies } from './installer';
import { resolveManagedPaths } from './managed-paths';
import { verifyRelease, type ApplicationInspection } from './release-verifier';
import { compiledReleaseTrust } from './release-trust';
import { SnapshotStore } from './snapshot-store';
import { DesiredStateStore } from '../service/desired-state';
import { createHealthClient } from '../service/health-client';
import { LaunchAgentController, loadLaunchAgentTemplate } from '../service/launch-agent';
import { createControlClient } from '../control/socket-client';
import type { ServiceIdentity, ServiceReleaseIdentity } from '../web/service-identity';
import type { PreviousInstallationState } from './types';

const execute = promisify(execFile);
const fixedEnvironment = Object.freeze({ PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LC_ALL: 'C', LANG: 'C' });

type ProductionInstallerOptions = Readonly<{
  app: App;
  origin: string;
}>;

export async function createProductionInstallerDependencies(
  options: ProductionInstallerOptions,
): Promise<InstallerDependencies> {
  await options.app.whenReady();
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error('USER_ID_UNAVAILABLE');
  const home = options.app.getPath('home');
  const paths = await resolveManagedPaths(home, uid);
  const trust = compiledReleaseTrust();
  const candidateBundle = resolveCandidateBundlePath(process.execPath);
  const health = createHealthClient({ origin: options.origin });
  const desiredState = new DesiredStateStore(join(paths.productData, 'service-state.json'));
  const template = await loadLaunchAgentTemplate(join(process.resourcesPath, 'fun.catbots.web.plist.template'));
  const logDirectory = join(home, 'Library', 'Logs', 'Catbots');
  await ensurePrivateDirectory(logDirectory, uid);
  const launchAgent = new LaunchAgentController({
    uid,
    executablePath: join(paths.application, 'Contents', 'MacOS', 'Catbots'),
    plistPath: paths.launchAgent,
    stdoutPath: join(logDirectory, 'service.log'),
    stderrPath: join(logDirectory, 'service.error.log'),
    template,
  });
  let verifiedRelease: ServiceReleaseIdentity | undefined;
  let candidateProcess: ChildProcess | undefined;
  let desiredServiceForInstall: 'running' | 'stopped' | undefined;
  const commandWrapper = new CommandWrapperTransaction();
  let preparedRequest: Readonly<{
    request: BootstrapInstallRequest;
    manifestBytes: Buffer;
    signatureBytes: Buffer;
    archiveBytes: Buffer;
    currentMacOS: string;
    architecture: 'arm64' | 'x64';
  }> | undefined;

  const verifyRequest = async (request: BootstrapInstallRequest): Promise<void> => {
    await assertTrustedTransportFiles(request, uid);
    const [manifestBytes, signatureBytes, archiveBytes] = await Promise.all([
      readFile(request.manifestPath), readFile(request.signaturePath), readFile(request.archivePath),
    ]);
    const currentMacOS = (await execute('/usr/bin/sw_vers', ['-productVersion'], { env: fixedEnvironment })).stdout.trim();
    const architecture = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x64' : fail('UNSUPPORTED_ARCHITECTURE');
    await verifyRelease({
      manifestBytes,
      signatureBytes,
      trustedPublicKeys: [trust.publicKey],
      architecture,
      archiveBytes,
      finalArtifactUrl: request.effectiveArtifactUrl,
      stagedAppPath: candidateBundle,
      currentMacOS,
      pinnedTeamId: trust.teamId,
    }, { inspectApplication: inspectMacApplication });
    preparedRequest = Object.freeze({ request: Object.freeze({ ...request }), manifestBytes, signatureBytes, archiveBytes, currentMacOS, architecture });
  };

  const deriveInput = async (request: BootstrapInstallRequest): Promise<InstallTransactionInput> => {
    if (preparedRequest === undefined || JSON.stringify(preparedRequest.request) !== JSON.stringify(request)) {
      throw new Error('INSTALL_REQUEST_NOT_VERIFIED');
    }
    const observedInstance = await health.current();
    const applicationExists = await pathExists(paths.application);
    const installedVersion = observedInstance?.version
      ?? (applicationExists ? await readInstalledVersion(paths.application) : undefined);
    const verified = await verifyRelease({
      manifestBytes: preparedRequest.manifestBytes,
      signatureBytes: preparedRequest.signatureBytes,
      trustedPublicKeys: [trust.publicKey],
      architecture: preparedRequest.architecture,
      archiveBytes: preparedRequest.archiveBytes,
      finalArtifactUrl: request.effectiveArtifactUrl,
      stagedAppPath: candidateBundle,
      currentMacOS: preparedRequest.currentMacOS,
      pinnedTeamId: trust.teamId,
      installedVersion,
    }, { inspectApplication: inspectMacApplication });
    verifiedRelease = Object.freeze({
      product: 'catbots', bundleId: 'com.catbots.desktop', releaseId: verified.releaseId,
      version: verified.version, commit: verified.commit, architecture: verified.architecture,
      protocolVersion: verified.protocolVersion, dataSchemaVersion: verified.dataSchemaVersion,
      resumePolicy: 'manual-only',
    });
    const desiredService = await deriveDesiredService(applicationExists, observedInstance, () => desiredState.read());
    desiredServiceForInstall = desiredService;
    const previousInstallation: PreviousInstallationState = applicationExists
      ? { kind: 'installed', releaseId: observedInstance?.releaseId ?? 'installed-unknown', desiredService }
      : { kind: 'absent' };
    return Object.freeze({
      operationId: `bootstrap-${randomUUID()}`,
      desiredReleaseId: verified.releaseId,
      previousInstallation,
      desiredService,
      preserveData: true,
      requiredSnapshotBytes: await treeBytes(paths.productData),
      paths,
    });
  };

  return {
    requests: { read: async (path) => JSON.parse(await readFile(path, 'utf8')) as unknown },
    verifyRequest,
    deriveInput,
    canonicalHealth: async () => {
      if (desiredServiceForInstall === 'stopped') {
        if (await health.current() !== undefined) throw new Error('CANONICAL_STOPPED_STATE_MISMATCH');
        return { product: 'catbots', bundleId: 'com.catbots.desktop', state: 'stopped' };
      }
      const observed = await health.waitForReady();
      if (verifiedRelease === undefined || !releaseMatches(observed, verifiedRelease)) {
        throw new Error('CANONICAL_HEALTH_IDENTITY_MISMATCH');
      }
      return observed;
    },
    transactionDependencies: {
      store: new InstallStore(paths.installerState),
      release: {
        stage: async () => candidateBundle,
        verify: async ({ releaseId, stagedAppPath }) => {
          if (verifiedRelease === undefined || verifiedRelease.releaseId !== releaseId || stagedAppPath !== candidateBundle) {
            throw new Error('VERIFIED_RELEASE_IDENTITY_MISMATCH');
          }
          return verifiedRelease;
        },
        discard: async () => undefined,
      },
      maintenance: {
        acquire: async ({ operationId, desiredReleaseId }) => acquireCurrentMaintenance({
          operationId,
          releaseId: desiredReleaseId,
          socketPath: join(paths.productData, 'control', 'catbots.sock'),
          health,
          createControl: (controlOptions) => createControlClient({
            socketPath: join(paths.productData, 'control', 'catbots.sock'),
            expectedInstanceId: controlOptions.expectedInstanceId,
          }),
          stopLaunchAgent: () => launchAgent.stop(),
          waitForStopped: () => waitForStopped(health),
        }),
        commit: async () => undefined,
        rollback: async () => undefined,
      },
      snapshots: new SnapshotStore(paths.installerState, paths.productData),
      application: new RenameApplicationActivator(),
      launchAgent: {
        install: async ({ operationId }) => {
          await commandWrapper.install({
            operationId,
            source: join(paths.application, 'Contents', 'Resources', 'catbots'),
            command: paths.command,
          });
        },
        rollback: async ({ operationId }) => {
          const failures: unknown[] = [];
          try { await launchAgent.stop(); } catch (error) { failures.push(error); }
          try { await commandWrapper.rollback({ operationId, command: paths.command }); } catch (error) { failures.push(error); }
          if (failures.length > 0) throw new AggregateError(failures, 'LAUNCH_AGENT_ROLLBACK_FAILED');
        },
        commit: async ({ operationId }) => commandWrapper.commit({ operationId, command: paths.command }),
      },
      candidate: {
        start: async ({ operationId }) => {
          candidateProcess = spawn(join(paths.application, 'Contents', 'MacOS', 'Catbots'), [
            '--serve-web', '--maintenance-operation', operationId,
          ], { env: { ...fixedEnvironment, HOME: home }, stdio: 'ignore' });
          candidateProcess.once('error', () => undefined);
        },
        verify: async ({ operationId, release }) => waitForMaintenanceCandidate(health, operationId, release),
      },
      service: {
        restore: async ({ desiredService }) => {
          await stopCandidate(candidateProcess);
          candidateProcess = undefined;
          await desiredState.write(desiredService);
          if (desiredService === 'running') await launchAgent.start();
          else await launchAgent.stop();
        },
        observe: async () => {
          const desired = await desiredState.read();
          if (desired === 'stopped') return { product: 'catbots', bundleId: 'com.catbots.desktop', state: 'stopped' };
          return health.waitForReady();
        },
      },
      now: () => new Date(),
    },
  };
}

export function resolveCandidateBundlePath(executablePath: string): string {
  return resolve(dirname(executablePath), '../..');
}

export async function acquireCurrentMaintenance(input: Readonly<{
  operationId: string;
  releaseId: string;
  socketPath: string;
  health: Readonly<{ current(): Promise<ServiceIdentity | undefined> }>;
  createControl(options: Readonly<{ socketPath: string; expectedInstanceId: string }>): Readonly<{
    execute(command: Readonly<Record<string, unknown>>): Promise<unknown>;
  }>;
  stopLaunchAgent(): Promise<void>;
  waitForStopped(): Promise<void>;
}>): Promise<Readonly<{ operationId: string }>> {
  const currentInstance = await input.health.current();
  if (currentInstance === undefined) return { operationId: input.operationId };
  const control = input.createControl({ socketPath: input.socketPath, expectedInstanceId: currentInstance.instanceId });
  const decision = await control.execute({
    kind: 'prepare-maintenance', reason: 'upgrade', operationId: input.operationId, targetRelease: input.releaseId,
  }) as { kind?: string; lease?: { operationId?: string } };
  if (decision.kind !== 'ready' || decision.lease?.operationId !== input.operationId) {
    throw new Error('MAINTENANCE_NOT_READY');
  }
  await control.execute({ kind: 'shutdown', leaseId: input.operationId });
  await input.stopLaunchAgent();
  await input.waitForStopped();
  return { operationId: input.operationId };
}

export async function ensurePrivateDirectory(path: string, uid: number): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const status = await lstat(path);
  if (!status.isDirectory() || status.isSymbolicLink() || status.uid !== uid) {
    throw new Error('PRIVATE_DIRECTORY_UNSAFE');
  }
  await chmod(path, 0o700);
}

export class CommandWrapperTransaction {
  async install(input: Readonly<{ operationId: string; source: string; command: string }>): Promise<void> {
    const backup = wrapperBackupPath(input.command, input.operationId);
    const marker = wrapperAbsenceMarkerPath(input.command, input.operationId);
    await mkdir(dirname(input.command), { recursive: true, mode: 0o700 });
    if (await pathExists(backup) || await pathExists(marker)) throw new Error('COMMAND_WRAPPER_BACKUP_CONFLICT');
    if (await pathExists(input.command)) await rename(input.command, backup);
    else await writeFile(marker, `${input.operationId}\n`, { flag: 'wx', mode: 0o600 });
    await copyFile(input.source, input.command);
    await chmod(input.command, 0o755);
  }

  async rollback(input: Readonly<{ operationId: string; command: string }>): Promise<void> {
    const backup = wrapperBackupPath(input.command, input.operationId);
    const marker = wrapperAbsenceMarkerPath(input.command, input.operationId);
    if (await pathExists(backup)) {
      await rm(input.command, { force: true });
      await rename(backup, input.command);
    } else if (await pathExists(marker)) {
      await rm(input.command, { force: true });
      await rm(marker, { force: true });
    }
  }

  async commit(input: Readonly<{ operationId: string; command: string }>): Promise<void> {
    await rm(wrapperBackupPath(input.command, input.operationId), { force: true });
    await rm(wrapperAbsenceMarkerPath(input.command, input.operationId), { force: true });
  }
}

const wrapperBackupPath = (command: string, operationId: string) => `${command}.rollback-${operationId}`;
const wrapperAbsenceMarkerPath = (command: string, operationId: string) => `${command}.absent-${operationId}`;

export async function deriveDesiredService(
  applicationExists: boolean,
  runningInstance: ServiceIdentity | undefined,
  readDesiredState: () => Promise<'running' | 'stopped'>,
): Promise<'running' | 'stopped'> {
  if (!applicationExists || runningInstance !== undefined) return 'running';
  return readDesiredState();
}

export async function waitForMaintenanceCandidate(
  health: Pick<ReturnType<typeof createHealthClient>, 'waitFor'>,
  operationId: string,
  release: ServiceReleaseIdentity,
): Promise<ServiceIdentity> {
  return health.waitFor((observed) => observed.readiness === 'maintenance'
    && observed.maintenanceOperationId === operationId
    && releaseMatches(observed, release));
}

async function readInstalledVersion(applicationPath: string): Promise<string> {
  const result = await execute('/usr/bin/plutil', [
    '-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', join(applicationPath, 'Contents', 'Info.plist'),
  ], { env: fixedEnvironment });
  return result.stdout.trim();
}

async function inspectMacApplication(path: string): Promise<ApplicationInspection> {
  const plist = join(path, 'Contents', 'Info.plist');
  const executable = join(path, 'Contents', 'MacOS', 'Catbots');
  const [{ stdout: bundleId }, signature, { stdout: architectures }] = await Promise.all([
    execute('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', plist], { env: fixedEnvironment }),
    execute('/usr/bin/codesign', ['--display', '--verbose=4', path], { env: fixedEnvironment }),
    execute('/usr/bin/lipo', ['-archs', executable], { env: fixedEnvironment }),
    execute('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', path], { env: fixedEnvironment }),
    execute('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=2', path], { env: fixedEnvironment }),
    execute('/usr/bin/xcrun', ['stapler', 'validate', path], { env: fixedEnvironment }),
  ]);
  const details = `${signature.stdout}\n${signature.stderr}`;
  const teamId = /^TeamIdentifier=(.+)$/m.exec(details)?.[1] ?? '';
  return {
    bundleId: bundleId.trim(), teamId,
    architectures: architectures.trim().split(/\s+/).map((value) => value === 'x86_64' ? 'x64' : value)
      .filter((value): value is 'arm64' | 'x64' => value === 'arm64' || value === 'x64'),
    codeSignatureValid: true,
    hardenedRuntime: /flags=.*\(runtime\)|Runtime Version=/m.test(details),
    gatekeeperAccepted: true,
    notarized: true,
  };
}

async function assertTrustedTransportFiles(request: BootstrapInstallRequest, uid: number): Promise<void> {
  const paths = [request.manifestPath, request.signaturePath, request.archivePath];
  const parent = await realpath(dirname(paths[0]!));
  const parentStatus = await lstat(parent);
  if (!parentStatus.isDirectory() || parentStatus.isSymbolicLink() || parentStatus.uid !== uid
    || (parentStatus.mode & 0o077) !== 0) throw new Error('INSTALL_TRANSPORT_DIRECTORY_UNSAFE');
  for (const path of paths) {
    if (await realpath(dirname(path)) !== parent) throw new Error('INSTALL_TRANSPORT_PATH_UNSAFE');
    const status = await lstat(path);
    if (!status.isFile() || status.isSymbolicLink() || status.uid !== uid || (status.mode & 0o022) !== 0) {
      throw new Error('INSTALL_TRANSPORT_PATH_UNSAFE');
    }
  }
}

async function treeBytes(path: string): Promise<number> {
  try {
    const status = await lstat(path);
    if (status.isSymbolicLink()) throw new Error('SNAPSHOT_SOURCE_UNSAFE');
    if (!status.isDirectory()) return status.size;
    const { readdir } = await import('node:fs/promises');
    let total = 0;
    for (const name of await readdir(path)) total += await treeBytes(join(path, name));
    return total;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function waitForStopped(health: ReturnType<typeof createHealthClient>): Promise<void> {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (await health.current() === undefined) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error('SERVICE_STOP_TIMEOUT');
}

export async function stopCandidate(child: ChildProcess | undefined): Promise<void> {
  if (child === undefined || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolveExit, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.off('exit', onExit);
      if (error === undefined) resolveExit(); else reject(error);
    };
    const onExit = () => finish();
    const timeout = setTimeout(() => finish(new Error('CANDIDATE_STOP_TIMEOUT')), 5_000);
    child.once('exit', onExit);
    if (child.exitCode !== null || child.signalCode !== null) return finish();
    if (!child.kill('SIGTERM')) finish(new Error('CANDIDATE_STOP_SIGNAL_FAILED'));
  });
}

function releaseMatches(observed: ServiceIdentity, release: ServiceReleaseIdentity): boolean {
  return Object.entries(release).every(([key, value]) => observed[key as keyof ServiceIdentity] === value);
}

const fail = (code: string): never => { throw new Error(code); };
