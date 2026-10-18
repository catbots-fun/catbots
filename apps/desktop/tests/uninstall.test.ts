import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { resolveManagedPaths } from '../src/main/installer/managed-paths';
import { InstallStore } from '../src/main/installer/install-store';
import {
  createInstalledUninstaller,
  purgeConfirmation,
  uninstall,
  type UninstallDependencies,
  type UninstallRequest,
} from '../src/main/installer/uninstall';
import type { ServiceIdentity, ServiceReleaseIdentity } from '../src/main/web/service-identity';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture(options: Readonly<{
  purgeData?: boolean;
  interactive?: boolean;
  answer?: string;
  maintenance?: Awaited<ReturnType<UninstallDependencies['maintenance']['begin']>>;
}> = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'catbots-uninstall-')));
  temporaryDirectories.push(root);
  const home = join(root, 'home');
  await mkdir(home, { mode: 0o700 });
  const paths = await resolveManagedPaths(home, process.getuid!());
  await mkdir(paths.application, { recursive: true });
  await writeFile(join(paths.application, 'Catbots'), 'application');
  await mkdir(join(home, '.local', 'bin'), { recursive: true });
  await writeFile(paths.command, 'command');
  await mkdir(join(home, 'Library', 'LaunchAgents'), { recursive: true });
  await writeFile(paths.launchAgent, 'launch agent');
  await mkdir(paths.installerState, { recursive: true });
  await writeFile(join(paths.installerState, 'release.json'), 'installer state');
  await mkdir(join(paths.productData, 'profiles'), { recursive: true });
  await mkdir(join(paths.productData, 'bots'), { recursive: true });
  await mkdir(join(paths.productData, 'logs'), { recursive: true });
  await writeFile(join(paths.productData, 'profiles', 'default.json'), 'profile');
  await writeFile(join(paths.productData, 'bots', 'paper.json'), 'bot');
  await writeFile(join(paths.productData, 'logs', 'service.log'), 'log');
  await writeFile(join(paths.productData, 'provider-selection.json'), 'provider config');

  const events: string[] = [];
  const recorded = new Set<string>();
  const dependencies: UninstallDependencies = {
    maintenance: {
      begin: vi.fn(async () => options.maintenance ?? {
        kind: 'ready' as const,
        lease: { operationId: 'uninstall-1', reason: 'uninstall' as const },
      }),
      commit: vi.fn(async () => { events.push('maintenance:commit'); }),
      rollback: vi.fn(async () => { events.push('maintenance:rollback'); }),
    },
    launchAgent: {
      stop: vi.fn(async () => { events.push('service:stop'); }),
    },
    store: {
      lockForUninstall: vi.fn(async () => ({ release: async () => undefined })),
      recordDeletion: vi.fn(async (record) => {
        recorded.add(record.quarantinePath ?? record.path);
        if (record.phase === 'prepared') events.push(`journal:${record.path}`);
      }),
      readDeletionJournal: vi.fn(async () => []),
    },
    confirmation: {
      isInteractive: () => options.interactive ?? true,
      read: vi.fn(async () => options.answer ?? purgeConfirmation),
    },
    filesystem: {
      lstat,
      remove: async (path, removeOptions) => { await rm(path, removeOptions); },
      beforeQuarantineRemoval: async (directory, name) => {
        const path = join(directory, name);
        if (!recorded.has(path)) throw new Error('DELETE_WITHOUT_JOURNAL');
        events.push(`delete:${path}`);
      },
    },
    now: () => new Date('2026-10-18T00:00:00.000Z'),
  };
  const request: UninstallRequest = {
    operationId: 'uninstall-1',
    paths,
    purgeData: options.purgeData ?? false,
  };
  return { dependencies, events, paths, request };
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

describe('safe uninstall', () => {
  it('returns maintenance blockers without stopping the service or deleting files', async () => {
    const blockers = [{ kind: 'active-deployment', deploymentId: 'paper-1', mode: 'paper', route: '/#deploy' }];
    const f = await fixture({ maintenance: { kind: 'blocked', blockers } });

    await expect(uninstall(f.request, f.dependencies)).resolves.toEqual({ kind: 'blocked', blockers });
    expect(f.events).toEqual([]);
    expect(await exists(f.paths.application)).toBe(true);
  });

  it('unloads the service and deletes only Catbots-managed program paths after journaling them', async () => {
    const f = await fixture();
    const unrelated = join(f.paths.home, 'Applications', 'Keep.app');
    await mkdir(unrelated, { recursive: true });

    await expect(uninstall(f.request, f.dependencies)).resolves.toEqual({
      kind: 'uninstalled',
      operationId: 'uninstall-1',
      dataPreserved: true,
    });

    expect(f.events).toEqual([
      'service:stop',
      `journal:${f.paths.application}`,
      `delete:${join(f.paths.installerState, 'uninstall-quarantine', 'uninstall-1', 'application')}`,
      `journal:${f.paths.command}`,
      `delete:${join(f.paths.installerState, 'uninstall-quarantine', 'uninstall-1', 'command')}`,
      `journal:${f.paths.launchAgent}`,
      `delete:${join(f.paths.installerState, 'uninstall-quarantine', 'uninstall-1', 'launch-agent')}`,
      'maintenance:commit',
    ]);
    expect(await exists(unrelated)).toBe(true);
  });

  it('preserves profiles, bots, logs, and provider configuration during normal uninstall', async () => {
    const f = await fixture();
    await uninstall(f.request, f.dependencies);

    await expect(readFile(join(f.paths.productData, 'profiles', 'default.json'), 'utf8')).resolves.toBe('profile');
    await expect(readFile(join(f.paths.productData, 'bots', 'paper.json'), 'utf8')).resolves.toBe('bot');
    await expect(readFile(join(f.paths.productData, 'logs', 'service.log'), 'utf8')).resolves.toBe('log');
    await expect(readFile(join(f.paths.productData, 'provider-selection.json'), 'utf8')).resolves.toBe('provider config');
  });

  it('purges product data only after the exact interactive confirmation', async () => {
    const rejected = await fixture({ purgeData: true, answer: 'purge catbots data' });
    await expect(uninstall(rejected.request, rejected.dependencies)).rejects.toThrow('PURGE_CONFIRMATION_MISMATCH');
    expect(await exists(rejected.paths.productData)).toBe(true);
    expect(rejected.events).toEqual([]);

    const accepted = await fixture({ purgeData: true, answer: purgeConfirmation });
    await expect(uninstall(accepted.request, accepted.dependencies)).resolves.toMatchObject({
      kind: 'purged',
      dataPreserved: false,
    });
    expect(await exists(accepted.paths.productData)).toBe(false);
  });

  it('rejects a noninteractive purge before maintenance or mutation', async () => {
    const f = await fixture({ purgeData: true, interactive: false });
    await expect(uninstall(f.request, f.dependencies)).rejects.toThrow('PURGE_REQUIRES_INTERACTIVE_CONFIRMATION');
    expect(f.events).toEqual([]);
    expect(await exists(f.paths.application)).toBe(true);
    expect(await exists(f.paths.productData)).toBe(true);
  });

  it('rejects a symlinked managed target before maintenance or mutation', async () => {
    const f = await fixture();
    const outside = join(f.paths.home, 'outside-app');
    await mkdir(outside);
    await rm(f.paths.application, { recursive: true });
    await symlink(outside, f.paths.application);

    await expect(uninstall(f.request, f.dependencies)).rejects.toThrow('UNSAFE_MANAGED_PATH');
    expect(f.events).toEqual([]);
    expect(await exists(outside)).toBe(true);
  });

  it('rejects a managed target whose ownership changed before deletion', async () => {
    const f = await fixture();
    const inspect = f.dependencies.filesystem!.lstat;
    f.dependencies.filesystem!.lstat = async (path) => {
      const status = await inspect(path);
      return path === f.paths.application
        ? {
            isSymbolicLink: () => false,
            isDirectory: () => status.isDirectory(),
            isFile: () => status.isFile(),
            uid: status.uid + 1,
            mode: status.mode,
            dev: status.dev,
            ino: status.ino,
          }
        : status;
    };

    await expect(uninstall(f.request, f.dependencies)).rejects.toThrow('UNSAFE_MANAGED_PATH');
    expect(f.events).toEqual([]);
    expect(await exists(f.paths.application)).toBe(true);
  });

  it('returns success when uninstall and purge are repeated', async () => {
    const uninstallFixture = await fixture();
    await uninstall(uninstallFixture.request, uninstallFixture.dependencies);
    await expect(uninstall(uninstallFixture.request, uninstallFixture.dependencies)).resolves.toMatchObject({
      kind: 'uninstalled',
      dataPreserved: true,
    });

    const purgeFixture = await fixture({ purgeData: true });
    await uninstall(purgeFixture.request, purgeFixture.dependencies);
    await expect(uninstall(purgeFixture.request, purgeFixture.dependencies)).resolves.toMatchObject({
      kind: 'purged',
      dataPreserved: false,
    });
  });

  it('holds the installer lock throughout validation and mutation', async () => {
    const f = await fixture();
    const store = new InstallStore(f.paths.installerState);
    let releaseRemoval!: () => void;
    const removalMayContinue = new Promise<void>((resolve) => { releaseRemoval = resolve; });
    let reportRemoval!: () => void;
    const removalStarted = new Promise<void>((resolve) => { reportRemoval = resolve; });
    const run = uninstall(f.request, {
      ...f.dependencies,
      store,
      filesystem: {
        ...f.dependencies.filesystem!,
        beforeQuarantineRemoval: async () => {
          reportRemoval();
          await removalMayContinue;
        },
      },
    });

    await removalStarted;
    await expect(new InstallStore(f.paths.installerState).lock('concurrent-install'))
      .rejects.toThrow('INSTALL_LOCKED');
    releaseRemoval();
    await expect(run).resolves.toMatchObject({ kind: 'uninstalled' });
  });

  it('restores an outside target when a managed parent is swapped before quarantine rename', async () => {
    const f = await fixture();
    const applications = join(f.paths.home, 'Applications');
    const savedApplications = join(f.paths.home, 'Applications.saved');
    const outside = join(f.paths.home, 'outside');
    const outsideApplication = join(outside, 'Catbots.app');
    await mkdir(outsideApplication, { recursive: true });
    await writeFile(join(outsideApplication, 'outside.txt'), 'untouched');
    let swapped = false;
    const filesystem = {
      ...f.dependencies.filesystem!,
      mkdir: async (path: string) => { await mkdir(path, { recursive: true, mode: 0o700 }); },
      rename: async (source: string, destination: string) => {
        if (!swapped && source === f.paths.application) {
          swapped = true;
          await rename(applications, savedApplications);
          await symlink(outside, applications);
        }
        await rename(source, destination);
      },
    };

    await expect(uninstall(f.request, { ...f.dependencies, filesystem }))
      .rejects.toThrow('UNSAFE_MANAGED_PATH');
    expect(swapped).toBe(true);
    await expect(readFile(join(outsideApplication, 'outside.txt'), 'utf8')).resolves.toBe('untouched');
  });

  it('recovers a journaled application quarantine after interrupted removal and succeeds on retry', async () => {
    const f = await fixture();
    const store = new InstallStore(f.paths.installerState);
    let interrupted = false;
    const first = uninstall(f.request, {
      ...f.dependencies,
      store,
      filesystem: {
        ...f.dependencies.filesystem!,
        beforeQuarantineRemoval: async (_directory, name) => {
          if (name === 'application' && !interrupted) {
            interrupted = true;
            throw new Error('SIMULATED_REMOVE_FAILURE');
          }
        },
      },
    });

    await expect(first).rejects.toThrow('SIMULATED_REMOVE_FAILURE');
    expect(await exists(f.paths.application)).toBe(false);
    expect(await exists(join(f.paths.installerState, 'uninstall-quarantine', 'uninstall-1', 'application'))).toBe(true);

    await expect(uninstall(f.request, {
      ...f.dependencies,
      store: new InstallStore(f.paths.installerState),
      filesystem: undefined,
    }))
      .resolves.toMatchObject({ kind: 'uninstalled', dataPreserved: true });
    expect(await exists(join(f.paths.installerState, 'uninstall-quarantine', 'uninstall-1', 'application'))).toBe(false);
    const records = await new InstallStore(f.paths.installerState).readDeletionJournal();
    expect(records.filter((record) => record.path === f.paths.application).at(-1)?.phase).toBe('complete');
  });

  it('does not roll forward a prepared-only deletion before maintenance is reacquired', async () => {
    const blockers = [{ kind: 'active-deployment', route: '/#deploy' }];
    const f = await fixture({ maintenance: { kind: 'blocked', blockers } });
    const status = await lstat(f.paths.application);
    const store = new InstallStore(f.paths.installerState);
    await store.recordDeletion({
      schemaVersion: 1,
      operationId: 'interrupted-uninstall',
      kind: 'delete',
      path: f.paths.application,
      recursive: true,
      quarantinePath: join(
        f.paths.installerState,
        'uninstall-quarantine',
        'interrupted-uninstall',
        'application',
      ),
      phase: 'prepared',
      identity: {
        dev: status.dev,
        ino: status.ino,
        uid: status.uid,
        directory: true,
        file: false,
      },
      recordedAt: '2026-10-18T00:00:00.000Z',
    });

    await expect(uninstall(f.request, {
      ...f.dependencies,
      store: new InstallStore(f.paths.installerState),
      filesystem: undefined,
    })).resolves.toEqual({ kind: 'blocked', blockers });
    expect(await exists(f.paths.application)).toBe(true);
    const records = await new InstallStore(f.paths.installerState).readDeletionJournal();
    expect(records.at(-1)).toMatchObject({
      operationId: 'interrupted-uninstall',
      path: f.paths.application,
      phase: 'complete',
    });
  });

  it('recovers a journaled product-data purge after remove failure and remains idempotent', async () => {
    const f = await fixture({ purgeData: true });
    let failed = false;
    await expect(uninstall(f.request, {
      ...f.dependencies,
      store: new InstallStore(f.paths.installerState),
      filesystem: {
        ...f.dependencies.filesystem!,
        beforeQuarantineRemoval: async (_directory, name) => {
          if (name === 'product-data' && !failed) {
            failed = true;
            throw new Error('SIMULATED_PURGE_REMOVE_FAILURE');
          }
        },
      },
    })).rejects.toThrow('SIMULATED_PURGE_REMOVE_FAILURE');
    expect(await exists(f.paths.productData)).toBe(false);

    await expect(uninstall(f.request, {
      ...f.dependencies,
      store: new InstallStore(f.paths.installerState),
      filesystem: undefined,
    })).resolves.toMatchObject({ kind: 'purged', dataPreserved: false });
    await expect(uninstall(f.request, {
      ...f.dependencies,
      store: new InstallStore(f.paths.installerState),
      filesystem: undefined,
    })).resolves.toMatchObject({ kind: 'purged', dataPreserved: false });
    const records = await new InstallStore(f.paths.installerState).readDeletionJournal();
    expect(records.filter((record) => record.path === f.paths.productData).at(-1)?.phase).toBe('complete');
  });

  it('rejects a captured quarantine object with the wrong identity without deleting it', async () => {
    const f = await fixture();
    await rm(f.paths.command);
    await rm(f.paths.launchAgent);
    const quarantineRoot = join(f.paths.installerState, 'uninstall-quarantine');
    const savedQuarantineRoot = join(f.paths.installerState, 'uninstall-quarantine.saved');
    const outside = join(f.paths.home, 'outside-quarantine');
    const outsideQuarantine = join(outside, 'uninstall-1', 'application');
    await mkdir(outsideQuarantine, { recursive: true });
    await writeFile(join(outsideQuarantine, 'outside.txt'), 'untouched');
    let swapped = false;

    await expect(uninstall(f.request, {
      ...f.dependencies,
      store: new InstallStore(f.paths.installerState),
      filesystem: {
        ...f.dependencies.filesystem!,
        beforeQuarantineRemoval: async (_directory, name) => {
          if (name !== 'application' || swapped) return;
          swapped = true;
          await rename(quarantineRoot, savedQuarantineRoot);
          await symlink(outside, quarantineRoot);
        },
      },
    })).rejects.toThrow('UNSAFE_UNINSTALL_FILE_REFERENCE');

    expect(swapped).toBe(true);
    await expect(readFile(join(outsideQuarantine, 'outside.txt'), 'utf8')).resolves.toBe('untouched');
    await expect(readFile(join(
      savedQuarantineRoot,
      'uninstall-1',
      'application',
      'Catbots',
    ), 'utf8')).resolves.toBe('application');
  });
});

describe('uninstall deletion journal', () => {
  it('durably records deletion intent in order before paths are removed', async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'catbots-uninstall-store-')));
    temporaryDirectories.push(directory);
    const store = new InstallStore(directory);
    const first = {
      schemaVersion: 1 as const,
      operationId: 'uninstall-1',
      kind: 'delete' as const,
      path: '/Users/tester/Applications/Catbots.app',
      recursive: true,
      quarantinePath: '/Users/tester/Library/Application Support/Catbots Installer/uninstall-quarantine/uninstall-1/application',
      phase: 'prepared' as const,
      identity: { dev: 1, ino: 2, uid: 501, directory: true, file: false },
      recordedAt: '2026-10-18T00:00:00.000Z',
    };
    const second = {
      ...first,
      path: '/Users/tester/.local/bin/catbots',
      recursive: false,
      quarantinePath: '/Users/tester/Library/Application Support/Catbots Installer/uninstall-quarantine/uninstall-1/command',
      recordedAt: '2026-10-18T00:00:01.000Z',
    };

    await store.recordDeletion(first);
    await store.recordDeletion(second);

    await expect(store.readDeletionJournal()).resolves.toEqual([first, second]);
  });

  it('rejects a pre-existing deletion-journal symlink without changing its target', async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'catbots-uninstall-store-')));
    temporaryDirectories.push(directory);
    const target = join(directory, 'outside.jsonl');
    await writeFile(target, 'unchanged');
    await symlink(target, join(directory, 'uninstall-deletions.jsonl'));
    const store = new InstallStore(directory);

    await expect(store.recordDeletion({
      schemaVersion: 1,
      operationId: 'uninstall-1',
      kind: 'delete',
      path: '/Users/tester/Applications/Catbots.app',
      recursive: true,
      quarantinePath: '/Users/tester/Library/Application Support/Catbots Installer/uninstall-quarantine/uninstall-1/application',
      phase: 'prepared',
      identity: { dev: 1, ino: 2, uid: 501, directory: true, file: false },
      recordedAt: '2026-10-18T00:00:00.000Z',
    })).rejects.toThrow('UNSAFE_UNINSTALL_DELETION_JOURNAL');
    await expect(readFile(target, 'utf8')).resolves.toBe('unchanged');
  });

  it('rejects a deletion journal reported as owned by another user', async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'catbots-uninstall-store-')));
    temporaryDirectories.push(directory);
    const journal = join(directory, 'uninstall-deletions.jsonl');
    await writeFile(journal, '');
    const store = new InstallStore(directory, {
      inspectDeletionJournal: async (path) => {
        const status = await lstat(path);
        Object.defineProperty(status, 'uid', { value: status.uid + 1 });
        return status;
      },
    });

    await expect(store.recordDeletion({
      schemaVersion: 1,
      operationId: 'uninstall-1',
      kind: 'delete',
      path: '/Users/tester/Applications/Catbots.app',
      recursive: true,
      quarantinePath: '/Users/tester/Library/Application Support/Catbots Installer/uninstall-quarantine/uninstall-1/application',
      phase: 'prepared',
      identity: { dev: 1, ino: 2, uid: 501, directory: true, file: false },
      recordedAt: '2026-10-18T00:00:00.000Z',
    })).rejects.toThrow('UNSAFE_UNINSTALL_DELETION_JOURNAL');
  });

  it('keeps journal writes bound to the verified installer state when its parent is swapped', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'catbots-uninstall-store-')));
    temporaryDirectories.push(root);
    const support = join(root, 'Application Support');
    const directory = join(support, 'Catbots Installer');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const store = new InstallStore(directory);
    const lease = await store.lockForUninstall('uninstall-1');
    const savedSupport = join(root, 'Application Support.saved');
    const outside = join(root, 'outside');
    const outsideState = join(outside, 'Catbots Installer');
    await mkdir(outsideState, { recursive: true, mode: 0o700 });
    const outsideJournal = join(outsideState, 'uninstall-deletions.jsonl');
    await writeFile(outsideJournal, 'outside');
    await rename(support, savedSupport);
    await symlink(outside, support);

    await store.recordDeletion({
      schemaVersion: 1,
      operationId: 'uninstall-1',
      kind: 'delete',
      path: '/Users/tester/Applications/Catbots.app',
      recursive: true,
      quarantinePath: '/Users/tester/Library/Application Support/Catbots Installer/uninstall-quarantine/uninstall-1/application',
      phase: 'prepared',
      identity: { dev: 1, ino: 2, uid: 501, directory: true, file: false },
      recordedAt: '2026-10-18T00:00:00.000Z',
    });
    await expect(readFile(outsideJournal, 'utf8')).resolves.toBe('outside');
    await expect(readFile(join(savedSupport, 'Catbots Installer', 'uninstall-deletions.jsonl'), 'utf8'))
      .resolves.toContain('Catbots.app');
    await rm(support);
    await rename(savedSupport, support);
    await lease.release();
  });
});

describe('installed uninstall composition', () => {
  it('resolves managed paths, acquires exact-owner maintenance, shuts down, and unloads', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'catbots-installed-uninstall-')));
    temporaryDirectories.push(root);
    const home = join(root, 'home');
    await mkdir(home, { mode: 0o700 });
    const paths = await resolveManagedPaths(home, process.getuid!());
    await mkdir(paths.application, { recursive: true });
    await mkdir(join(home, '.local', 'bin'), { recursive: true });
    await writeFile(paths.command, 'command');
    await mkdir(join(home, 'Library', 'LaunchAgents'), { recursive: true });
    await writeFile(paths.launchAgent, 'plist');
    await mkdir(paths.installerState, { recursive: true });
    await mkdir(paths.productData, { recursive: true });
    await writeFile(join(paths.productData, 'profile.json'), 'preserved');
    const release: ServiceReleaseIdentity = {
      product: 'catbots',
      bundleId: 'com.catbots.desktop',
      releaseId: 'release-1',
      version: '1.0.0',
      commit: 'abc123',
      architecture: 'arm64',
      protocolVersion: 1,
      dataSchemaVersion: 1,
      resumePolicy: 'manual-only',
    };
    const identity: ServiceIdentity = {
      ...release,
      instanceId: 'instance-1',
      readiness: 'ready',
    };
    const commands: unknown[] = [];
    const events: string[] = [];
    const execute = vi.fn(async (command) => {
      commands.push(command);
      if ((command as { kind: string }).kind === 'prepare-maintenance') {
        return { kind: 'ready', lease: { operationId: 'uninstall-1', reason: 'uninstall' } };
      }
      return { kind: 'stopping' };
    });
    const run = createInstalledUninstaller({
      homeDirectory: home,
      uid: process.getuid!(),
      operationId: () => 'uninstall-1',
      confirmation: { isInteractive: () => true, read: async () => purgeConfirmation },
      health: { current: async () => identity },
      expectedRelease: release,
      socketPath: join(paths.productData, 'control', 'catbots.sock'),
      createControl: () => ({ execute }),
      launchAgent: () => ({
        status: async () => ({ loaded: true }),
        stop: async () => { events.push('agent:stop'); },
      }),
    });

    await expect(run(false)).resolves.toEqual({
      kind: 'uninstalled',
      operationId: 'uninstall-1',
      dataPreserved: true,
    });
    expect(commands).toEqual([
      { kind: 'prepare-maintenance', operationId: 'uninstall-1', reason: 'uninstall' },
      { kind: 'shutdown', leaseId: 'uninstall-1' },
    ]);
    expect(events).toEqual(['agent:stop']);
    await expect(readFile(join(paths.productData, 'profile.json'), 'utf8')).resolves.toBe('preserved');
    expect(await exists(paths.application)).toBe(false);
  });

  it('fails closed without stopping or deleting when the LaunchAgent is loaded but health is unavailable', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'catbots-installed-uninstall-')));
    temporaryDirectories.push(root);
    const home = join(root, 'home');
    await mkdir(home, { mode: 0o700 });
    const paths = await resolveManagedPaths(home, process.getuid!());
    await mkdir(paths.application, { recursive: true });
    const stop = vi.fn(async () => undefined);
    const createControl = vi.fn();
    const release: ServiceReleaseIdentity = {
      product: 'catbots', bundleId: 'com.catbots.desktop', releaseId: 'release-1',
      version: '1.0.0', commit: 'abc123', architecture: 'arm64', protocolVersion: 1,
      dataSchemaVersion: 1, resumePolicy: 'manual-only',
    };
    const run = createInstalledUninstaller({
      homeDirectory: home,
      uid: process.getuid!(),
      operationId: () => 'uninstall-1',
      confirmation: { isInteractive: () => true, read: async () => purgeConfirmation },
      health: { current: async () => undefined },
      expectedRelease: release,
      socketPath: join(paths.productData, 'control', 'catbots.sock'),
      createControl,
      launchAgent: () => ({ status: async () => ({ loaded: true }), stop }),
    });

    await expect(run(false)).rejects.toThrow('SERVICE_HEALTH_UNAVAILABLE');
    expect(stop).not.toHaveBeenCalled();
    expect(createControl).not.toHaveBeenCalled();
    expect(await exists(paths.application)).toBe(true);
  });

  it('succeeds idempotently when both the LaunchAgent and service are confirmed absent', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'catbots-installed-uninstall-')));
    temporaryDirectories.push(root);
    const home = join(root, 'home');
    await mkdir(home, { mode: 0o700 });
    const paths = await resolveManagedPaths(home, process.getuid!());
    const stop = vi.fn(async () => undefined);
    const createControl = vi.fn();
    const release: ServiceReleaseIdentity = {
      product: 'catbots', bundleId: 'com.catbots.desktop', releaseId: 'release-1',
      version: '1.0.0', commit: 'abc123', architecture: 'arm64', protocolVersion: 1,
      dataSchemaVersion: 1, resumePolicy: 'manual-only',
    };
    const run = createInstalledUninstaller({
      homeDirectory: home,
      uid: process.getuid!(),
      operationId: () => 'uninstall-1',
      confirmation: { isInteractive: () => true, read: async () => purgeConfirmation },
      health: { current: async () => undefined },
      expectedRelease: release,
      socketPath: join(paths.productData, 'control', 'catbots.sock'),
      createControl,
      launchAgent: () => ({ status: async () => ({ loaded: false }), stop }),
    });

    await expect(run(false)).resolves.toMatchObject({ kind: 'uninstalled', dataPreserved: true });
    expect(createControl).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalledOnce();
  });
});
