import { describe, expect, it, vi } from 'vitest';
import { dispatchPublicCliCommand, runRuntimeEntrypoint } from '../src/main/application/runtime-entrypoint';
import { createProductionInstallerCommandRunner } from '../src/main/installer/installer';

function platform(argv: readonly string[], packaged = true) {
  const calls: string[] = [];
  return {
    calls,
    dependencies: {
      argv,
      packaged,
      requestSingleInstanceLock: vi.fn(() => { calls.push('lock'); return true; }),
      startOwner: vi.fn(async () => {
        calls.push('owner');
        return { close: async () => undefined };
      }),
      openUi: vi.fn(async () => { calls.push('open'); return 0; }),
      runCli: vi.fn(async (command) => { calls.push(`cli:${command}`); return 0; }),
      runControl: vi.fn(async () => { calls.push('control'); return 0; }),
      runInstaller: vi.fn(async () => { calls.push('installer'); return 0; }),
    },
  };
}

describe('runtime entrypoint', () => {
  it('dispatches wrapper uninstall to the production uninstall runner', async () => {
    const calls: string[] = [];
    const dependencies = {
      runService: vi.fn(async (command) => { calls.push(`service:${command}`); return 0; }),
      runUninstall: vi.fn(async (purgeData) => { calls.push(`uninstall:${purgeData}`); return 0; }),
    };

    await expect(dispatchPublicCliCommand(
      { kind: 'uninstall', purgeData: true },
      dependencies,
    )).resolves.toBe(0);
    await expect(dispatchPublicCliCommand('status', dependencies)).resolves.toBe(0);
    expect(calls).toEqual(['uninstall:true', 'service:status']);
  });

  it('starts the sole application owner only for serve-web', async () => {
    const value = platform(['Catbots', '--serve-web']);

    await expect(runRuntimeEntrypoint(value.dependencies)).resolves.toBe(0);
    expect(value.calls).toEqual(['lock', 'owner']);
  });

  it.each(['open', 'status', 'start', 'stop'] as const)(
    'routes packaged CLI %s without importing the application owner',
    async (command) => {
      const value = platform(['Catbots', '--cli', command]);

      await expect(runRuntimeEntrypoint(value.dependencies)).resolves.toBe(0);
      expect(value.calls).toEqual([`cli:${command}`]);
      expect(value.dependencies.startOwner).not.toHaveBeenCalled();
    },
  );

  it('routes public purge uninstall without importing the application owner', async () => {
    const value = platform(['Catbots', '--cli', 'uninstall', '--purge-data']);
    value.dependencies.runCli = vi.fn(async (command) => {
      value.calls.push(`cli:${JSON.stringify(command)}`);
      return 0;
    });

    await expect(runRuntimeEntrypoint(value.dependencies)).resolves.toBe(0);
    expect(value.calls).toEqual(['cli:{"kind":"uninstall","purgeData":true}']);
    expect(value.dependencies.startOwner).not.toHaveBeenCalled();
  });

  it('routes a packaged Finder launch through authenticated browser open', async () => {
    const value = platform(['Catbots']);

    await expect(runRuntimeEntrypoint(value.dependencies)).resolves.toBe(0);
    expect(value.calls).toEqual(['open']);
    expect(value.dependencies.startOwner).not.toHaveBeenCalled();
  });

  it('keeps the Electron Forge development launch compatible', async () => {
    const value = platform(['electron', '.'], false);

    await expect(runRuntimeEntrypoint(value.dependencies)).resolves.toBe(0);
    expect(value.calls).toEqual(['open']);
  });

  it('routes packaged installer reconciliation to the fail-closed production boundary', async () => {
    const value = platform([
      'Catbots',
      '--installer',
      'reconcile',
      '/private/tmp/catbots-install/request.json',
    ]);
    const dependencies = {
      ...value.dependencies,
      runInstaller: createProductionInstallerCommandRunner(),
    };

    await expect(runRuntimeEntrypoint(dependencies)).rejects.toThrow('INSTALLER_PLATFORM_UNAVAILABLE');
    expect(value.dependencies.startOwner).not.toHaveBeenCalled();
  });

  it('runs direct packaged installer uninstall through its production platform', async () => {
    const value = platform(['Catbots', '--installer', 'uninstall', '--purge-data']);
    const requests: boolean[] = [];
    const dependencies = {
      ...value.dependencies,
      runInstaller: createProductionInstallerCommandRunner({
        uninstall: async (purgeData) => {
          requests.push(purgeData);
          return { kind: 'purged', operationId: 'uninstall-1', dataPreserved: false };
        },
      }),
    };

    await expect(runRuntimeEntrypoint(dependencies)).resolves.toBe(0);
    expect(requests).toEqual([true]);
    expect(value.dependencies.startOwner).not.toHaveBeenCalled();
  });
});
