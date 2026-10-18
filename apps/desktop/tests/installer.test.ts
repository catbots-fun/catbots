import { describe, expect, it } from 'vitest';

import {
  createInstaller,
  createInstallerCommandRunner,
  createProductionInstallerCommandRunner,
  runInstallerCommand,
  formatUninstallOutcome,
} from '../src/main/installer/installer';
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

describe('CatbotsInstaller boundary', () => {
  it('reads one reconcile request and delegates it to the recoverable transaction', async () => {
    const result = { kind: 'installed' as const, operationId: 'operation-1', releaseId: '0.2.0+abc123' };
    const events: string[] = [];
    const installer = createInstaller({
      requests: {
        read: async (path) => {
          events.push(`request:${path}`);
          return input;
        },
      },
      recover: async () => { events.push('recover'); return { kind: 'none' as const }; },
      transact: async (observed) => {
        events.push(`transact:${observed.operationId}`);
        return result;
      },
      transactionDependencies: {} as InstallerTransactionDependencies,
    });

    await expect(installer.reconcile('/private/tmp/catbots-install/request.json')).resolves.toEqual(result);
    expect(events).toEqual([
      'recover',
      'request:/private/tmp/catbots-install/request.json',
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
    const installer = createInstaller({
      requests: { read: async () => ({ ...input, unexpected: true }) },
      recover: async () => ({ kind: 'none' as const }),
      transact: async () => {
        transacted = true;
        return { kind: 'installed' as const, operationId: 'operation-1', releaseId: '0.2.0+abc123' };
      },
      transactionDependencies: {} as InstallerTransactionDependencies,
    });

    await expect(installer.reconcile('/private/tmp/request.json')).rejects.toThrow('INSTALL_REQUEST_INVALID');
    expect(transacted).toBe(false);
  });

  it('rejects impossible previous-installation combinations', async () => {
    const installer = createInstaller({
      requests: {
        read: async () => ({
          ...input,
          previousInstallation: { kind: 'absent', releaseId: 'must-not-exist' },
        }),
      },
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
      requests: { read: async () => input },
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
      requests: { read: async () => input },
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
