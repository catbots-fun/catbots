import { describe, expect, it, vi } from 'vitest';
import { runRuntimeEntrypoint } from '../src/main/application/runtime-entrypoint';
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
});
