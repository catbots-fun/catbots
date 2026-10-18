import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  ensureDirectoryDurable,
  RenameApplicationActivator,
  nodeApplicationActivationPlatform,
  runInstallTransaction,
} from '../src/main/installer/install-transaction';
import type { InstallerTransactionDependencies } from '../src/main/installer/install-transaction';
import type { InstallJournal, ManagedPaths } from '../src/main/installer/types';

const paths: ManagedPaths = {
  home: '/Users/tester',
  application: '/Users/tester/Applications/Catbots.app',
  command: '/Users/tester/.local/bin/catbots',
  launchAgent: '/Users/tester/Library/LaunchAgents/fun.catbots.web.plist',
  installerState: '/Users/tester/Library/Application Support/Catbots Installer',
  productData: '/Users/tester/Library/Application Support/Catbots',
};
const temporaryDirectories: string[] = [];
const releaseIdentity = {
  product: 'catbots' as const,
  bundleId: 'com.catbots.desktop' as const,
  releaseId: '0.2.0+abc123',
  version: '0.2.0',
  commit: 'abc123',
  architecture: 'arm64' as const,
  protocolVersion: 1,
  dataSchemaVersion: 1,
  resumePolicy: 'manual-only' as const,
};
const previousInstalled = {
  kind: 'installed' as const,
  releaseId: '0.1.0+def456',
  desiredService: 'stopped' as const,
};

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function fixture(failAt?: string, initialJournal?: InstallJournal) {
  const events: string[] = [];
  const serviceRestores: Array<Readonly<{
    operationId: string;
    desiredService: 'running' | 'stopped';
    releaseId?: string;
  }>> = [];
  let journal: InstallJournal | undefined = initialJournal;
  let serviceDesired: 'running' | 'stopped' = 'running';
  const effect = async (event: string) => {
    events.push(event);
    if (event === failAt) throw new Error(`FAULT:${event}`);
  };
  const dependencies: InstallerTransactionDependencies = {
    store: {
      lock: async () => ({ release: async () => { events.push('lock:release'); } }),
      lockForRecovery: async () => ({ release: async () => { events.push('recovery-lock:release'); } }),
      readJournal: async () => journal,
      writeJournal: async (next: InstallJournal) => {
        journal = next;
        events.push(`journal:${next.phase}`);
      },
      clearJournal: async () => { journal = undefined; events.push('journal:clear'); },
    },
    release: {
      stage: async () => {
        await effect('release:stage');
        return '/Users/tester/Applications/.Catbots.operation-1/Catbots.app';
      },
      verify: async () => { await effect('release:verify'); return releaseIdentity; },
      discard: async () => { await effect('release:discard'); },
    },
    maintenance: {
      acquire: async () => {
        events.push('maintenance:acquire');
        return { operationId: 'operation-1' };
      },
      commit: async () => { events.push('maintenance:commit'); },
      rollback: async () => { events.push('maintenance:rollback'); },
    },
    snapshots: {
      create: async () => { await effect('snapshot:create'); },
      restore: async () => { await effect('snapshot:restore'); },
      exists: async () => {
        if (failAt === 'snapshot:exists') throw new Error('FAULT:snapshot:exists');
        return true;
      },
    },
    application: {
      stageCurrent: async () => { await effect('application:stage-current'); },
      activate: async () => { await effect('application:activate'); },
      rollback: async () => { await effect('application:rollback'); },
      commit: async () => { await effect('application:commit'); },
    },
    launchAgent: {
      install: async () => { await effect('launch-agent:install'); },
      rollback: async () => { await effect('launch-agent:rollback'); },
      commit: async () => { await effect('launch-agent:commit'); },
    },
    candidate: {
      start: async () => { await effect('candidate:start'); },
      verify: async () => {
        await effect('candidate:verify');
        return {
          ...releaseIdentity,
          instanceId: 'candidate-instance',
          readiness: 'maintenance' as const,
          maintenanceOperationId: 'operation-1',
        };
      },
    },
    service: {
      restore: async (input: Readonly<{
        operationId: string;
        desiredService: 'running' | 'stopped';
        releaseId?: string;
      }>) => {
        serviceRestores.push(input);
        serviceDesired = input.desiredService;
        await effect('service:restore');
      },
      observe: async () => {
        await effect('service:observe');
        if (serviceDesired === 'stopped') {
          return {
            product: 'catbots' as const,
            bundleId: 'com.catbots.desktop' as const,
            state: 'stopped' as const,
          };
        }
        return {
          ...releaseIdentity,
          instanceId: 'canonical-instance',
          readiness: 'ready' as const,
        };
      },
    },
    now: () => new Date('2026-10-18T00:00:00.000Z'),
  };
  return { dependencies, events, serviceRestores, journal: () => journal };
}

describe('install transaction', () => {
  it('activates and rolls back applications with same-volume renames', async () => {
    const root = await mkdtemp(join(tmpdir(), 'catbots-activation-'));
    temporaryDirectories.push(root);
    const applicationPath = join(root, 'Catbots.app');
    const stagedAppPath = join(root, '.candidate', 'Catbots.app');
    await mkdir(applicationPath, { recursive: true });
    await mkdir(stagedAppPath, { recursive: true });
    await writeFile(join(applicationPath, 'release.txt'), 'old');
    await writeFile(join(stagedAppPath, 'release.txt'), 'new');
    const activator = new RenameApplicationActivator();

    await activator.stageCurrent({ operationId: 'operation-1', applicationPath, installerStatePath: root });
    await activator.activate({ operationId: 'operation-1', stagedAppPath, applicationPath });
    await expect(readFile(join(applicationPath, 'release.txt'), 'utf8')).resolves.toBe('new');

    await activator.rollback({ operationId: 'operation-1', applicationPath, installerStatePath: root });
    await activator.rollback({ operationId: 'operation-1', applicationPath, installerStatePath: root });
    await expect(readFile(join(applicationPath, 'release.txt'), 'utf8')).resolves.toBe('old');
  });

  it('rolls back a first install when the application directory did not exist', async () => {
    const root = await mkdtemp(join(tmpdir(), 'catbots-first-activation-'));
    temporaryDirectories.push(root);
    const applicationPath = join(root, 'Applications', 'Catbots.app');
    const stagedAppPath = join(root, '.candidate', 'Catbots.app');
    await mkdir(stagedAppPath, { recursive: true });
    await writeFile(join(stagedAppPath, 'release.txt'), 'new');
    const activator = new RenameApplicationActivator();

    await activator.stageCurrent({ operationId: 'operation-1', applicationPath, installerStatePath: root });
    await activator.activate({ operationId: 'operation-1', stagedAppPath, applicationPath });
    await activator.rollback({ operationId: 'operation-1', applicationPath, installerStatePath: root });

    await expect(readFile(join(applicationPath, 'release.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves staged evidence when first-install marker creation runs out of disk', async () => {
    const root = await mkdtemp(join(tmpdir(), 'catbots-disk-full-'));
    temporaryDirectories.push(root);
    const applicationPath = join(root, 'Applications', 'Catbots.app');
    const stagedAppPath = join(root, '.candidate', 'Catbots.app');
    await mkdir(stagedAppPath, { recursive: true });
    await writeFile(join(stagedAppPath, 'release.txt'), 'new');
    const activator = new RenameApplicationActivator({
      ...nodeApplicationActivationPlatform,
      open: async () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); },
    });

    await expect(activator.stageCurrent({ operationId: 'operation-1', applicationPath, installerStatePath: root }))
      .rejects.toMatchObject({ code: 'ENOSPC' });
    await expect(readFile(join(stagedAppPath, 'release.txt'), 'utf8')).resolves.toBe('new');
    await expect(readFile(`${applicationPath}.absent-operation-1`, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps the prior app backup when directory fsync fails after staging it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'catbots-fsync-fault-'));
    temporaryDirectories.push(root);
    const applicationPath = join(root, 'Catbots.app');
    await mkdir(applicationPath);
    await writeFile(join(applicationPath, 'release.txt'), 'old');
    const activator = new RenameApplicationActivator({
      ...nodeApplicationActivationPlatform,
      syncDirectory: async () => { throw new Error('FSYNC_FAILED'); },
    });

    await expect(activator.stageCurrent({ operationId: 'operation-1', applicationPath, installerStatePath: root }))
      .rejects.toThrow('FSYNC_FAILED');
    await expect(readFile(`${applicationPath}.rollback-operation-1/release.txt`, 'utf8')).resolves.toBe('old');
  });

  it('keeps both candidate and prior app evidence when the activation move fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'catbots-move-fault-'));
    temporaryDirectories.push(root);
    const applicationPath = join(root, 'Catbots.app');
    const stagedAppPath = join(root, '.candidate', 'Catbots.app');
    await mkdir(applicationPath);
    await mkdir(stagedAppPath, { recursive: true });
    await writeFile(join(applicationPath, 'release.txt'), 'old');
    await writeFile(join(stagedAppPath, 'release.txt'), 'new');
    const activator = new RenameApplicationActivator({
      ...nodeApplicationActivationPlatform,
      rename: async (source, destination) => {
        if (source === stagedAppPath) throw new Error('APP_MOVE_FAILED');
        await nodeApplicationActivationPlatform.rename(source, destination);
      },
    });

    await activator.stageCurrent({ operationId: 'operation-1', applicationPath, installerStatePath: root });
    await expect(activator.activate({ operationId: 'operation-1', stagedAppPath, applicationPath }))
      .rejects.toThrow('APP_MOVE_FAILED');
    await expect(readFile(`${applicationPath}.rollback-operation-1/release.txt`, 'utf8')).resolves.toBe('old');
    await expect(readFile(join(stagedAppPath, 'release.txt'), 'utf8')).resolves.toBe('new');
  });

  it('syncs both parents after cross-directory activation and deduplicates a shared parent', async () => {
    const events: string[] = [];
    const platform = {
      ...nodeApplicationActivationPlatform,
      ensureDirectory: async (path: string) => { events.push(`mkdir:${path}`); },
      device: async () => 1n,
      rename: async (source: string, destination: string) => { events.push(`rename:${source}->${destination}`); },
      syncDirectory: async (path: string) => { events.push(`sync:${path}`); },
    };
    const activator = new RenameApplicationActivator(platform);

    await activator.activate({
      operationId: 'operation-1',
      stagedAppPath: '/volume/staging/Catbots.app',
      applicationPath: '/volume/Applications/Catbots.app',
    });
    expect(events.slice(-3)).toEqual([
      'rename:/volume/staging/Catbots.app->/volume/Applications/Catbots.app',
      'sync:/volume/staging',
      'sync:/volume/Applications',
    ]);

    events.length = 0;
    await activator.activate({
      operationId: 'operation-1',
      stagedAppPath: '/volume/Applications/Candidate.app',
      applicationPath: '/volume/Applications/Catbots.app',
    });
    expect(events.filter((event) => event === 'sync:/volume/Applications')).toHaveLength(1);
  });

  it('creates missing parent ancestry one level at a time and syncs each parent entry', async () => {
    const existing = new Set(['/volume']);
    const events: string[] = [];
    await ensureDirectoryDurable('/volume/Applications/Catbots', {
      stat: async (path) => {
        if (!existing.has(path)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      },
      mkdir: async (path) => { existing.add(path); events.push(`mkdir:${path}`); },
      syncDirectory: async (path) => { events.push(`sync:${path}`); },
    });

    expect(events).toEqual([
      'mkdir:/volume/Applications',
      'sync:/volume',
      'mkdir:/volume/Applications/Catbots',
      'sync:/volume/Applications',
    ]);
  });

  it('stops parent creation when an ancestry fsync fails', async () => {
    const existing = new Set(['/volume']);
    const events: string[] = [];
    await expect(ensureDirectoryDurable('/volume/Applications/Catbots', {
      stat: async (path) => {
        if (!existing.has(path)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      },
      mkdir: async (path) => { existing.add(path); events.push(`mkdir:${path}`); },
      syncDirectory: async (path) => {
        events.push(`sync:${path}`);
        throw new Error('PARENT_FSYNC_FAILED');
      },
    })).rejects.toThrow('PARENT_FSYNC_FAILED');

    expect(events).toEqual(['mkdir:/volume/Applications', 'sync:/volume']);
    expect(existing.has('/volume/Applications/Catbots')).toBe(false);
  });

  it.each(['backup', 'marker'] as const)('keeps rollback journal unresolved when %s inspection is uncertain', async (inspection) => {
    const f = fixture('candidate:verify');
    const activator = new RenameApplicationActivator({
      ...nodeApplicationActivationPlatform,
      exists: async (path) => {
        if ((inspection === 'backup' && path.includes('.rollback-operation-1'))
          || (inspection === 'marker' && path.includes('.absent-operation-1'))) {
          throw Object.assign(new Error('inspection failed'), { code: 'EIO' });
        }
        if (inspection === 'marker' && path.includes('.rollback-operation-1')) return false;
        return nodeApplicationActivationPlatform.exists(path);
      },
    });
    f.dependencies.application.rollback = async (input) => activator.rollback(input);

    await expect(runInstallTransaction({
      operationId: 'operation-1',
      desiredReleaseId: '0.2.0+abc123',
      previousInstallation: previousInstalled,
      desiredService: 'running',
      preserveData: true,
      requiredSnapshotBytes: 42,
      paths,
    }, f.dependencies)).rejects.toThrow('INSTALL_ROLLBACK_FAILED');

    expect(f.journal()?.phase).toBe('rolling-back');
  });

  it('verifies the staged release before acquiring maintenance and journals before every mutation', async () => {
    const f = fixture();

    await expect(runInstallTransaction({
      operationId: 'operation-1',
      desiredReleaseId: '0.2.0+abc123',
      previousInstallation: previousInstalled,
      desiredService: 'running',
      preserveData: true,
      requiredSnapshotBytes: 42,
      paths,
    }, f.dependencies)).resolves.toEqual({
      kind: 'installed',
      operationId: 'operation-1',
      releaseId: '0.2.0+abc123',
    });

    expect(f.events).toEqual([
      'journal:prepared',
      'release:stage',
      'release:verify',
      'journal:release-verified',
      'journal:maintenance-prepared',
      'maintenance:acquire',
      'journal:data-snapshotted',
      'snapshot:create',
      'journal:old-app-staged',
      'application:stage-current',
      'journal:new-app-installed',
      'application:activate',
      'journal:launch-agent-written',
      'launch-agent:install',
      'journal:candidate-verifying',
      'candidate:start',
      'candidate:verify',
      'service:restore',
      'service:observe',
      'journal:committed',
      'maintenance:commit',
      'launch-agent:commit',
      'application:commit',
      'journal:complete',
      'lock:release',
    ]);
    expect(f.journal()?.phase).toBe('complete');
  });

  it('recovers a terminal prior operation before starting the next install', async () => {
    const prior: InstallJournal = {
      schemaVersion: 1,
      operationId: 'prior-operation',
      phase: 'rolled-back',
      rollbackFromPhase: 'candidate-verifying',
      desiredReleaseId: '0.1.0+def456',
      previousInstallation: { kind: 'absent' },
      desiredService: 'stopped',
      preserveData: true,
      paths,
      createdAt: '2026-10-17T00:00:00.000Z',
      updatedAt: '2026-10-17T00:01:00.000Z',
    };
    const f = fixture(undefined, prior);

    await expect(runInstallTransaction({
      operationId: 'operation-1',
      desiredReleaseId: '0.2.0+abc123',
      previousInstallation: { kind: 'absent' },
      desiredService: 'stopped',
      preserveData: true,
      requiredSnapshotBytes: 42,
      paths,
    }, f.dependencies)).resolves.toMatchObject({ kind: 'installed', operationId: 'operation-1' });

    expect(f.events.slice(0, 3)).toEqual([
      'journal:clear',
      'recovery-lock:release',
      'journal:prepared',
    ]);
  });

  it('restores the prior app and data snapshot when candidate verification fails', async () => {
    const f = fixture('candidate:verify');

    await expect(runInstallTransaction({
      operationId: 'operation-1',
      desiredReleaseId: '0.2.0+abc123',
      previousInstallation: previousInstalled,
      desiredService: 'running',
      preserveData: true,
      requiredSnapshotBytes: 42,
      paths,
    }, f.dependencies)).rejects.toThrow('FAULT:candidate:verify');

    expect(f.events.slice(-11)).toEqual([
      'candidate:start',
      'candidate:verify',
      'journal:rolling-back',
      'launch-agent:rollback',
      'application:rollback',
      'snapshot:restore',
      'release:discard',
      'service:restore',
      'maintenance:rollback',
      'journal:rolled-back',
      'lock:release',
    ]);
    expect(f.journal()?.phase).toBe('rolled-back');
    expect(f.serviceRestores).toEqual([{
      operationId: 'operation-1',
      desiredService: 'stopped',
      releaseId: '0.1.0+def456',
    }]);
  });

  it('discards a staged release that fails verification without entering maintenance', async () => {
    const f = fixture('release:verify');

    await expect(runInstallTransaction({
      operationId: 'operation-1',
      desiredReleaseId: '0.2.0+abc123',
      previousInstallation: { kind: 'absent' },
      desiredService: 'stopped',
      preserveData: true,
      requiredSnapshotBytes: 42,
      paths,
    }, f.dependencies)).rejects.toThrow('FAULT:release:verify');

    expect(f.events).toEqual([
      'journal:prepared',
      'release:stage',
      'release:verify',
      'journal:rolling-back',
      'release:discard',
      'journal:rolled-back',
      'lock:release',
    ]);
  });

  it('still releases maintenance when snapshot inspection fails during rollback', async () => {
    const f = fixture('snapshot:exists');
    f.dependencies.candidate.verify = async () => { throw new Error('CANDIDATE_FAILED'); };

    await expect(runInstallTransaction({
      operationId: 'operation-1',
      desiredReleaseId: '0.2.0+abc123',
      previousInstallation: previousInstalled,
      desiredService: 'running',
      preserveData: true,
      requiredSnapshotBytes: 42,
      paths,
    }, f.dependencies)).rejects.toThrow('INSTALL_ROLLBACK_FAILED');

    expect(f.events).toContain('maintenance:rollback');
    expect(f.events).toContain('service:restore');
    expect(f.journal()?.phase).toBe('rolling-back');
  });

  it('rejects candidate health that does not exactly identify the operation and release', async () => {
    const f = fixture();
    f.dependencies.candidate.verify = async () => ({
      ...releaseIdentity,
      instanceId: 'candidate-instance',
      readiness: 'maintenance' as const,
      maintenanceOperationId: 'another-operation',
    });

    await expect(runInstallTransaction({
      operationId: 'operation-1',
      desiredReleaseId: '0.2.0+abc123',
      previousInstallation: previousInstalled,
      desiredService: 'running',
      preserveData: true,
      requiredSnapshotBytes: 42,
      paths,
    }, f.dependencies)).rejects.toThrow('CANDIDATE_HEALTH_IDENTITY_MISMATCH');

    expect(f.journal()?.phase).toBe('rolled-back');
  });

  it('rejects candidate health whose service release identity differs from the verified app', async () => {
    const f = fixture();
    f.dependencies.candidate.verify = async () => ({
      ...releaseIdentity,
      commit: 'different-commit',
      instanceId: 'candidate-instance',
      readiness: 'maintenance' as const,
      maintenanceOperationId: 'operation-1',
    });

    await expect(runInstallTransaction({
      operationId: 'operation-1',
      desiredReleaseId: '0.2.0+abc123',
      previousInstallation: previousInstalled,
      desiredService: 'running',
      preserveData: true,
      requiredSnapshotBytes: 42,
      paths,
    }, f.dependencies)).rejects.toThrow('CANDIDATE_HEALTH_IDENTITY_MISMATCH');

    expect(f.journal()?.phase).toBe('rolled-back');
  });

  it('rolls back when canonical health identifies a different release', async () => {
    const f = fixture();
    f.dependencies.service.observe = async () => ({
      product: 'catbots' as const,
      bundleId: 'com.catbots.desktop' as const,
      releaseId: '0.1.0+wrong',
      version: '0.1.0',
      commit: 'wrong',
      architecture: 'arm64' as const,
      protocolVersion: 1,
      dataSchemaVersion: 1,
      instanceId: 'wrong-instance',
      readiness: 'ready' as const,
      resumePolicy: 'manual-only' as const,
    });

    await expect(runInstallTransaction({
      operationId: 'operation-1',
      desiredReleaseId: '0.2.0+abc123',
      previousInstallation: previousInstalled,
      desiredService: 'running',
      preserveData: true,
      requiredSnapshotBytes: 42,
      paths,
    }, f.dependencies)).rejects.toThrow('CANONICAL_HEALTH_IDENTITY_MISMATCH');

    expect(f.journal()?.phase).toBe('rolled-back');
    expect(f.events.indexOf('service:observe')).toBeLessThan(f.events.indexOf('maintenance:rollback'));
  });

  it('rolls back when canonical health observation fails', async () => {
    const f = fixture();
    f.dependencies.service.observe = async () => { throw new Error('CANONICAL_HEALTH_UNAVAILABLE'); };

    await expect(runInstallTransaction({
      operationId: 'operation-1',
      desiredReleaseId: '0.2.0+abc123',
      previousInstallation: previousInstalled,
      desiredService: 'running',
      preserveData: true,
      requiredSnapshotBytes: 42,
      paths,
    }, f.dependencies)).rejects.toThrow('CANONICAL_HEALTH_UNAVAILABLE');

    expect(f.journal()?.phase).toBe('rolled-back');
  });

  it('observes exact stopped state before committing a desired-stopped install', async () => {
    const f = fixture();
    f.dependencies.service.observe = async () => {
      f.events.push('service:observe');
      return {
        product: 'catbots' as const,
        bundleId: 'com.catbots.desktop' as const,
        state: 'stopped' as const,
      };
    };

    await expect(runInstallTransaction({
      operationId: 'operation-1',
      desiredReleaseId: '0.2.0+abc123',
      previousInstallation: { kind: 'absent' },
      desiredService: 'stopped',
      preserveData: true,
      requiredSnapshotBytes: 42,
      paths,
    }, f.dependencies)).resolves.toMatchObject({ kind: 'installed' });

    expect(f.events).toContain('service:restore');
    expect(f.events).toContain('service:observe');
    expect(f.events.indexOf('service:observe')).toBeLessThan(f.events.indexOf('journal:committed'));
    expect(f.events.indexOf('service:observe')).toBeLessThan(f.events.indexOf('maintenance:commit'));
  });
});
