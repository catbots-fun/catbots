import { describe, expect, it } from 'vitest';

import {
  createInstaller,
  createInstallerCommandRunner,
  createProductionInstallerCommandRunner,
  runInstallerCommand,
  formatUninstallOutcome,
} from '../src/main/installer/installer';
import {
  deriveDesiredService,
  resolveCandidateBundlePath,
  waitForMaintenanceCandidate,
} from '../src/main/installer/production-installer';
import type { InstallTransactionInput, InstallerTransactionDependencies } from '../src/main/installer/install-transaction';

const input: InstallTransactionInput = {
  operationId: 'operation-1',
  desiredReleaseId: '0.2.0+abc123',
  previousInstallation: {
    kind: 'installed',
    releaseId: '0.1.0+def456',
    desiredService: 'stopped',
  },
  desiredService: 'running',
  preserveData: true,
  requiredSnapshotBytes: 42,
  paths: {
    home: '/Users/tester',
    application: '/Users/tester/Applications/Catbots.app',
    command: '/Users/tester/.local/bin/catbots',
    launchAgent: '/Users/tester/Library/LaunchAgents/fun.catbots.web.plist',
    installerState: '/Users/tester/Library/Application Support/Catbots Installer',
    productData: '/Users/tester/Library/Application Support/Catbots',
  },
};

const transportRequest = {
  schemaVersion: 1 as const,
  manifestPath: '/private/tmp/catbots-install/manifest.json',
  signaturePath: '/private/tmp/catbots-install/manifest.json.sig',
  archivePath: '/private/tmp/catbots-install/Catbots.zip',
  effectiveArtifactUrl: 'https://release-assets.githubusercontent.com/catbots/Catbots.zip',
};
const releaseIdentityForTest = {
  product: 'catbots' as const, bundleId: 'com.catbots.desktop' as const,
  releaseId: '0.2.0+abc123', version: '0.2.0', commit: 'abc123', architecture: 'arm64' as const,
  protocolVersion: 1, dataSchemaVersion: 7, resumePolicy: 'manual-only' as const,
};

describe('CatbotsInstaller boundary', () => {
  it('reads one reconcile request and delegates it to the recoverable transaction', async () => {
    const result = { kind: 'installed' as const, operationId: 'operation-1', releaseId: '0.2.0+abc123' };
    const events: string[] = [];
    const installer = createInstaller({
      requests: {
        read: async (path) => {
          events.push(`request:${path}`);
          return transportRequest;
        },
      },
      verifyRequest: async () => { events.push('verify'); },
      deriveInput: async () => { events.push('derive'); return input; },
      recover: async () => { events.push('recover'); return { kind: 'none' as const }; },
      transact: async (observed) => {
        events.push(`transact:${observed.operationId}`);
        return result;
      },
      transactionDependencies: {} as InstallerTransactionDependencies,
    });

    await expect(installer.reconcile('/private/tmp/catbots-install/request.json')).resolves.toEqual(result);
    expect(events).toEqual([
      'request:/private/tmp/catbots-install/request.json',
      'verify',
      'recover',
      'derive',
      'transact:operation-1',
    ]);
  });

  it('fails closed when trusted platform assembly is unavailable', async () => {
    const runner = createProductionInstallerCommandRunner();
    await expect(runner({ kind: 'reconcile', requestFile: '/private/tmp/request.json' }))
      .rejects.toThrow('INSTALLER_PLATFORM_UNAVAILABLE');
  });

  it('rejects malformed reconcile requests before transaction mutation', async () => {
    let transacted = false;
    let recovered = false;
    const installer = createInstaller({
      requests: { read: async () => ({ ...transportRequest, desiredService: 'running' }) },
      deriveInput: async () => { throw new Error('must not derive'); },
      recover: async () => { recovered = true; return { kind: 'none' as const }; },
      transact: async () => {
        transacted = true;
        return { kind: 'installed' as const, operationId: 'operation-1', releaseId: '0.2.0+abc123' };
      },
      transactionDependencies: {} as InstallerTransactionDependencies,
    });

    await expect(installer.reconcile('/private/tmp/request.json')).rejects.toThrow('INSTALL_REQUEST_INVALID');
    expect(recovered).toBe(false);
    expect(transacted).toBe(false);
  });

  it('verifies the transport before recovering any prior transaction', async () => {
    let recovered = false;
    const installer = createInstaller({
      requests: { read: async () => transportRequest },
      verifyRequest: async () => { throw new Error('RELEASE_SIGNATURE_INVALID'); },
      deriveInput: async () => { throw new Error('must not derive'); },
      recover: async () => { recovered = true; return { kind: 'none' as const }; },
      transactionDependencies: {} as InstallerTransactionDependencies,
    });

    await expect(installer.reconcile('/private/tmp/request.json')).rejects.toThrow('RELEASE_SIGNATURE_INVALID');
    expect(recovered).toBe(false);
  });

  it('derives new transaction state only after rollback recovery restores the running service', async () => {
    let observedState = 'crashed-upgrade';
    const events: string[] = [];
    const installer = createInstaller({
      requests: { read: async () => transportRequest },
      verifyRequest: async () => { events.push(`verify:${observedState}`); },
      recover: async () => { observedState = 'old-service-running'; events.push('recover:rollback'); return { kind: 'rolled-back' as const, operationId: 'old', evidence: { action: 'rollback' as const, fromPhase: 'candidate-verifying' as const, resultPhase: 'rolled-back' as const } }; },
      deriveInput: async () => { events.push(`derive:${observedState}`); return input; },
      transact: async () => ({ kind: 'installed' as const, operationId: 'operation-1', releaseId: '0.2.0+abc123' }),
      transactionDependencies: {} as InstallerTransactionDependencies,
    });

    await installer.reconcile('/private/tmp/request.json');
    expect(events).toEqual(['verify:crashed-upgrade', 'recover:rollback', 'derive:old-service-running']);
  });

  it('re-derives state after committed recovery changes the installed release', async () => {
    let installedRelease = '0.1.0+old';
    const derived: string[] = [];
    const installer = createInstaller({
      requests: { read: async () => transportRequest },
      verifyRequest: async () => undefined,
      recover: async () => { installedRelease = '0.2.0+recovered'; return { kind: 'completed' as const, operationId: 'old', evidence: { action: 'complete' as const, fromPhase: 'committed' as const, resultPhase: 'complete' as const } }; },
      deriveInput: async () => { derived.push(installedRelease); return input; },
      transact: async () => ({ kind: 'installed' as const, operationId: 'operation-1', releaseId: '0.2.0+abc123' }),
      transactionDependencies: {} as InstallerTransactionDependencies,
    });

    await installer.reconcile('/private/tmp/request.json');
    expect(derived).toEqual(['0.2.0+recovered']);
  });

  it('rejects shell-supplied transaction policy', async () => {
    const installer = createInstaller({
      requests: {
        read: async () => ({
          ...transportRequest,
          paths: input.paths,
        }),
      },
      deriveInput: async () => { throw new Error('must not derive'); },
      recover: async () => ({ kind: 'none' as const }),
      transact: async () => {
        throw new Error('must not transact');
      },
      transactionDependencies: {} as InstallerTransactionDependencies,
    });

    await expect(installer.reconcile('/private/tmp/request.json')).rejects.toThrow('INSTALL_REQUEST_INVALID');
  });

  it('delegates an explicit purge request to the configured safe uninstaller', async () => {
    const requests: boolean[] = [];
    const installer = createInstaller({
      requests: { read: async () => transportRequest },
      deriveInput: async () => input,
      transactionDependencies: {} as InstallerTransactionDependencies,
      uninstall: async (purgeData) => {
        requests.push(purgeData);
        return { kind: 'purged', operationId: 'uninstall-1', dataPreserved: false };
      },
    });

    await expect(installer.uninstall(true)).resolves.toEqual({
      kind: 'purged',
      operationId: 'uninstall-1',
      dataPreserved: false,
    });
    expect(requests).toEqual([true]);
  });
});

describe('production installer platform assembly', () => {
  it('derives the candidate app bundle from its packaged executable', () => {
    expect(resolveCandidateBundlePath('/private/tmp/Catbots.app/Contents/MacOS/Catbots'))
      .toBe('/private/tmp/Catbots.app');
  });

  it('defaults a fresh install to running and preserves an existing explicit stopped intent', async () => {
    await expect(deriveDesiredService(false, undefined, async () => 'stopped')).resolves.toBe('running');
    await expect(deriveDesiredService(true, undefined, async () => 'stopped')).resolves.toBe('stopped');
    await expect(deriveDesiredService(true, undefined, async () => 'running')).resolves.toBe('running');
    await expect(deriveDesiredService(true, { readiness: 'ready' } as never, async () => 'stopped')).resolves.toBe('running');
  });

  it('waits for the exact maintenance candidate identity and operation', async () => {
    const wrong = { ...releaseIdentityForTest, instanceId: 'wrong', readiness: 'maintenance' as const, maintenanceOperationId: 'other' };
    const expected = { ...releaseIdentityForTest, instanceId: 'candidate', readiness: 'maintenance' as const, maintenanceOperationId: 'operation-1' };
    let predicate: ((identity: typeof expected) => boolean) | undefined;
    const health = {
      waitFor: async (observedPredicate: (identity: typeof expected) => boolean) => {
        predicate = observedPredicate;
        return expected;
      },
    };
    await expect(waitForMaintenanceCandidate(health as never, 'operation-1', releaseIdentityForTest)).resolves.toEqual(expected);
    expect(predicate?.(wrong)).toBe(false);
    expect(predicate?.(expected)).toBe(true);
  });
});

describe('installer command entrypoint', () => {
  it('routes reconcile through a constructed CatbotsInstaller boundary', async () => {
    const calls: string[] = [];
    const installer = {
      reconcile: async (requestFile: string) => {
        calls.push(requestFile);
        return { kind: 'installed' as const, operationId: 'operation-1', releaseId: '0.2.0+abc123' };
      },
      uninstall: async () => {
        throw new Error('must not uninstall');
      },
    };

    await expect(runInstallerCommand(
      { kind: 'reconcile', requestFile: '/private/tmp/catbots-install/request.json' },
      () => installer,
    )).resolves.toBe(0);
    expect(calls).toEqual(['/private/tmp/catbots-install/request.json']);
  });

  it('constructs the real installer boundary before reconciling', async () => {
    const events: string[] = [];
    const dependencies = {
      requests: { read: async () => transportRequest },
      deriveInput: async () => input,
      recover: async () => { events.push('recover'); return { kind: 'none' as const }; },
      transact: async () => {
        events.push('transact');
        return { kind: 'installed' as const, operationId: 'operation-1', releaseId: '0.2.0+abc123' };
      },
      transactionDependencies: {} as InstallerTransactionDependencies,
    };
    const runner = createInstallerCommandRunner({
      loadDependencies: async () => { events.push('dependencies'); return dependencies; },
    });

    await expect(runner({ kind: 'reconcile', requestFile: '/private/tmp/request.json' })).resolves.toBe(0);
    expect(events).toEqual(['dependencies', 'recover', 'transact']);
  });

  it('reports the canonical ready health with the installed result', async () => {
    const health = {
      product: 'catbots' as const, bundleId: 'com.catbots.desktop' as const,
      releaseId: '0.2.0+abc123', version: '0.2.0', commit: 'abc123', architecture: 'arm64' as const,
      protocolVersion: 1, dataSchemaVersion: 7, instanceId: 'instance-1', readiness: 'ready' as const,
      resumePolicy: 'manual-only' as const,
    };
    const reports: unknown[] = [];
    const runner = createProductionInstallerCommandRunner({
      loadDependencies: async () => ({
        requests: { read: async () => transportRequest }, deriveInput: async () => input,
        recover: async () => ({ kind: 'none' as const }),
        transact: async () => ({ kind: 'installed' as const, operationId: 'operation-1', releaseId: '0.2.0+abc123' }),
        canonicalHealth: async () => health,
        transactionDependencies: {} as InstallerTransactionDependencies,
      }),
      reportInstall: (result) => { reports.push(result); },
    });
    await expect(runner({ kind: 'reconcile', requestFile: '/private/tmp/request.json' })).resolves.toBe(0);
    expect(reports).toEqual([{ kind: 'installed', operationId: 'operation-1', releaseId: '0.2.0+abc123', health }]);
  });

  it('reports an explicitly stopped canonical result without requiring ready health', async () => {
    const health = { product: 'catbots' as const, bundleId: 'com.catbots.desktop' as const, state: 'stopped' as const };
    const reports: unknown[] = [];
    const runner = createProductionInstallerCommandRunner({
      loadDependencies: async () => ({
        requests: { read: async () => transportRequest }, deriveInput: async () => input,
        recover: async () => ({ kind: 'none' as const }),
        transact: async () => ({ kind: 'installed' as const, operationId: 'operation-1', releaseId: '0.2.0+abc123' }),
        canonicalHealth: async () => health,
        transactionDependencies: {} as InstallerTransactionDependencies,
      }),
      reportInstall: (result) => { reports.push(result); },
    });
    await expect(runner({ kind: 'reconcile', requestFile: '/private/tmp/request.json' })).resolves.toBe(0);
    expect(reports).toEqual([{ kind: 'installed', operationId: 'operation-1', releaseId: '0.2.0+abc123', health }]);
  });

  it('routes uninstall and the explicit purge flag through the installer boundary', async () => {
    const requests: boolean[] = [];
    const installer = {
      reconcile: async () => {
        throw new Error('must not reconcile');
      },
      uninstall: async (purgeData: boolean) => {
        requests.push(purgeData);
        return {
          kind: purgeData ? 'purged' as const : 'uninstalled' as const,
          operationId: 'uninstall-1',
          dataPreserved: !purgeData,
        };
      },
    };

    await expect(runInstallerCommand(
      { kind: 'uninstall', purgeData: false },
      () => installer,
    )).resolves.toBe(0);
    await expect(runInstallerCommand(
      { kind: 'uninstall', purgeData: true },
      () => installer,
    )).resolves.toBe(0);
    expect(requests).toEqual([false, true]);
  });

  it('returns a nonzero public exit when production uninstall is blocked by maintenance', async () => {
    let stdout = '';
    const runner = createProductionInstallerCommandRunner({
      uninstall: async () => ({
        kind: 'blocked',
        blockers: [
          { kind: 'active-deployment', deploymentId: 'paper-1', route: '/#deploy' },
          { kind: 'database-repair-required', route: '/#repair' },
        ],
      }),
      reportUninstall: (outcome) => { stdout += formatUninstallOutcome(outcome, 'http://127.0.0.1:5180'); },
    });

    await expect(runner({ kind: 'uninstall', purgeData: false })).resolves.toBe(2);
    expect(stdout).toBe([
      'Catbots could not uninstall safely.',
      '- active-deployment: http://127.0.0.1:5180/#deploy',
      '- database-repair-required: http://127.0.0.1:5180/#repair',
      'Resolve every blocker and run catbots uninstall again.',
      '',
    ].join('\n'));
  });
});
