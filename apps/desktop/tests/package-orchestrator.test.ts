import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { createRunner, createSignalController, restoreProcessOptions, runDesktopCommand, runForgeWithSignalHandling, runPackaging, type SpawnedChild } from '../../../scripts/package-desktop.mjs';

function fakeChild(): SpawnedChild {
  const child = new EventEmitter() as SpawnedChild;
  child.kill = () => undefined;
  return child;
}

describe('package orchestrator runner', () => {
  it.each(['package', 'make'] as const)('fails closed before spawning any production %s command without validated trust', async (command) => {
    let spawned = false;
    await expect(runDesktopCommand(command, {
      run: async () => { spawned = true; },
      assertTrust: async () => { throw new Error('RELEASE_TRUST_REQUIRED'); },
    })).rejects.toThrow('RELEASE_TRUST_REQUIRED');
    expect(spawned).toBe(false);
  });

  it('runs Electron native rebuild, Forge start, and host ABI restoration in order for development', async () => {
    const calls: Array<{ command: string; args: string[]; cwd: string; environment?: NodeJS.ProcessEnv }> = [];
    const run = async (command: string, args: string[], cwd?: string, _onSpawn?: unknown, options?: { env?: NodeJS.ProcessEnv }) => {
      calls.push({ command, args, cwd: cwd ?? '', environment: options?.env });
    };

    await runDesktopCommand('start', { run });

    expect(calls).toHaveLength(3);
    expect(calls[0]).toMatchObject({ args: ['-f', '-w', 'better-sqlite3'], cwd: expect.stringMatching(/apps\/desktop$/) });
    expect(calls[0]?.command).toMatch(/electron-rebuild$/);
    expect(calls[1]).toMatchObject({ args: ['start'], cwd: expect.stringMatching(/apps\/desktop$/) });
    expect(calls[1]?.command).toMatch(/electron-forge$/);
    expect(calls[1]?.environment?.CATBOTS_INTERNAL_FORGE_LIFECYCLE).toBe('start');
    expect(calls[1]?.environment?.CATBOTS_INTERNAL_FORGE_PARENT_PID).toBe(String(process.pid));
    expect(calls[2]).toMatchObject({ args: ['run', 'install', '--prefix', expect.stringMatching(/node_modules\/better-sqlite3$/)] });
  });

  it.each(['package', 'make'] as const)('passes a matching internal lifecycle to Forge %s after the release gate succeeds', async (command) => {
    const calls: Array<{ args: string[]; environment?: NodeJS.ProcessEnv }> = [];
    await runDesktopCommand(command, {
      assertTrust: async () => undefined,
      run: async (_command, args, _cwd, _onSpawn, options) => {
        calls.push({ args, environment: options?.env });
      },
    });
    expect(calls.find((call) => call.args[0] === command)?.environment?.CATBOTS_INTERNAL_FORGE_LIFECYCLE)
      .toBe(command);
  });

  it('uses the desktop directory by default and propagates nonzero child exits', async () => {
    const calls: Array<{ cwd: string }> = [];
    const run = createRunner((_command: string, _args: string[], options: { cwd: string }) => {
      calls.push({ cwd: options.cwd });
      const child = fakeChild();
      queueMicrotask(() => child.emit('exit', 0, null));
      return child;
    });

    await run('forge', []);
    expect(calls[0]?.cwd).toMatch(/apps\/desktop$/);
    expect(calls[0]?.cwd).not.toMatch(/catbots-m0$/);
  });

  it('spawns POSIX host restoration in an isolated process group without terminal stdio', async () => {
    const options: Array<{ detached?: boolean; stdio: string; windowsHide?: boolean }> = [];
    const run = createRunner((_command: string, _args: string[], spawnOptions: { detached?: boolean; stdio: string; windowsHide?: boolean }) => {
      options.push(spawnOptions);
      const child = fakeChild();
      queueMicrotask(() => child.emit('exit', 0, null));
      return child;
    });
    await run('npm', ['run', 'install'], '/workspace', undefined, restoreProcessOptions('darwin'));
    expect(options[0]).toMatchObject({ detached: true, stdio: 'ignore' });
  });

  it('spawns Windows host restoration detached from the parent console', async () => {
    const options: Array<{ detached?: boolean; stdio: string; windowsHide?: boolean }> = [];
    const run = createRunner((_command: string, _args: string[], spawnOptions: { detached?: boolean; stdio: string; windowsHide?: boolean }) => {
      options.push(spawnOptions);
      const child = fakeChild();
      queueMicrotask(() => child.emit('exit', 0, null));
      return child;
    });
    await run('npm.cmd', ['run', 'install'], 'C:\\workspace', undefined, restoreProcessOptions('win32'));
    expect(options[0]).toMatchObject({ detached: true, stdio: 'ignore', windowsHide: true });
  });
});

describe('package signal controller', () => {
  it('restores once, removes listeners, and exits conventionally on SIGINT', async () => {
    const listeners = new Map<string, () => Promise<void>>();
    const calls: string[] = [];
    createSignalController({
      on: (signal: string, handler: () => Promise<void>) => listeners.set(signal, handler),
      off: (signal: string) => listeners.delete(signal),
      terminate: () => calls.push('terminate'),
      waitForExit: async () => { calls.push('wait'); },
      restoreHost: async () => { calls.push('restore'); },
      exit: (code: number) => calls.push(`exit:${code}`),
    });

    await listeners.get('SIGINT')?.();
    expect(calls).toEqual(['wait', 'terminate', 'restore', 'exit:130']);
    expect(listeners.size).toBe(0);
  });

  it('uses SIGTERM exit code and does not restore twice for duplicate signals', async () => {
    const listeners = new Map<string, () => Promise<void>>();
    const calls: string[] = [];
    createSignalController({
      on: (s: string, h: () => Promise<void>) => listeners.set(s, h),
      off: (s: string) => listeners.delete(s),
      terminate: () => calls.push('terminate'),
      waitForExit: async () => { calls.push('wait'); },
      restoreHost: async () => { calls.push('restore'); },
      exit: (code: number) => calls.push(`exit:${code}`),
    });

    await listeners.get('SIGTERM')?.();
    await listeners.get('SIGTERM')?.();
    expect(calls).toEqual(['wait', 'terminate', 'restore', 'exit:143']);
  });

  it('reports a fixed diagnostic and exits nonzero when signal restoration fails', async () => {
    const listeners = new Map<string, () => Promise<void>>();
    const diagnostics: string[] = [];
    const exits: number[] = [];
    createSignalController({
      on: (s: string, h: () => Promise<void>) => listeners.set(s, h),
      off: (s: string) => listeners.delete(s),
      terminate: () => undefined,
      waitForExit: async () => undefined,
      restoreHost: async () => { throw new Error('restore'); },
      exit: (code: number) => exits.push(code),
      report: (message: string) => diagnostics.push(message),
    });

    await listeners.get('SIGINT')?.();
    expect(exits).toEqual([1]);
    expect(diagnostics).toEqual(['Catbots host ABI restoration failed after interruption.']);
    expect(listeners.size).toBe(0);
  });
});

describe('Forge child signal wiring', () => {
  it('forwards SIGINT to the spawned Forge child, waits for exit, restores once, and removes listeners', async () => {
    const listeners = new Map<string, () => Promise<void>>();
    const child = fakeChild();
    const calls: string[] = [];
    child.kill = (signal: string) => calls.push(`kill:${signal}`);
    const run = createRunner(() => child);
    const running = runForgeWithSignalHandling({
      runCommand: run,
      command: 'forge',
      args: ['package'],
      on: (signal: string, handler: () => Promise<void>) => listeners.set(signal, handler),
      off: (signal: string) => listeners.delete(signal),
      exit: (code: number) => calls.push(`exit:${code}`),
      restoreHost: async () => { calls.push('restore'); },
    });

    const interrupt = listeners.get('SIGINT');
    expect(interrupt).toBeDefined();
    const interrupted = interrupt?.();
    expect(calls).toEqual(['kill:SIGINT']);
    child.emit('exit', null, 'SIGINT');
    await interrupted;
    await expect(running).rejects.toThrow('forge failed (SIGINT)');
    expect(calls).toEqual(['kill:SIGINT', 'restore', 'exit:130']);
    expect(listeners.size).toBe(0);
  });
});

describe('package lifecycle', () => {
  it('resolves immediately for an already-exited child', async () => {
    const child = fakeChild() as SpawnedChild & { exitCode: number | null; signalCode: string | null };
    child.exitCode = 0;
    child.signalCode = null;
    await expect((await import('../../../scripts/package-desktop.mjs')).waitForChildExit(child)).resolves.toBeUndefined();
  });

  it('handles SIGINT during native rebuild, waits for the child, and restores once', async () => {
    const listeners = new Map<string, () => Promise<void>>();
    const calls: string[] = [];
    const child = fakeChild();
    child.kill = (signal: string) => calls.push(`kill:${signal}`);
    const running = runPackaging({
      rebuildElectron: async (onSpawn?: (child: SpawnedChild) => void) => {
        onSpawn?.(child);
        await new Promise<void>((_resolve, reject) => child.once('exit', () => reject(new Error('interrupted rebuild'))));
      },
      forge: async () => { throw new Error('Forge must not run'); },
      restoreHost: async () => { calls.push('restore'); },
      signalOptions: {
        on: (signal: string, handler: () => Promise<void>) => listeners.set(signal, handler),
        off: (signal: string) => listeners.delete(signal),
        exit: (code: number) => calls.push(`exit:${code}`),
      },
    });

    const interrupted = listeners.get('SIGINT')?.();
    expect(calls).toEqual(['kill:SIGINT']);
    child.emit('exit', null, 'SIGINT');
    await interrupted;
    await expect(running).rejects.toThrow('interrupted rebuild');
    expect(calls).toEqual(['kill:SIGINT', 'restore', 'exit:130']);
    expect(listeners.size).toBe(0);
  });

  it('waits for an in-progress host restore when SIGTERM arrives during restoration', async () => {
    const listeners = new Map<string, () => Promise<void>>();
    const calls: string[] = [];
    let markRestoreStarted: (() => void) | undefined;
    let finishRestore: (() => void) | undefined;
    const restoreStarted = new Promise<void>((resolveStarted) => {
      markRestoreStarted = resolveStarted;
    });
    const restoreGate = new Promise<void>((resolveRestore) => {
      finishRestore = () => { calls.push('restore-finished'); resolveRestore(); };
    });
    const running = runPackaging({
      rebuildElectron: async () => undefined,
      forge: async () => undefined,
      restoreHost: async () => {
        calls.push('restore-started');
        markRestoreStarted?.();
        await restoreGate;
      },
      signalOptions: {
        on: (signal: string, handler: () => Promise<void>) => listeners.set(signal, handler),
        off: (signal: string) => listeners.delete(signal),
        exit: (code: number) => calls.push(`exit:${code}`),
      },
    });
    await restoreStarted;
    const interrupted = listeners.get('SIGTERM')?.();
    finishRestore?.();
    await interrupted;
    await running;
    expect(calls).toEqual(['restore-started', 'restore-finished', 'exit:143']);
    expect(listeners.size).toBe(0);
  });

  it('awaits an isolated restoration child without forwarding parent SIGTERM', async () => {
    const listeners = new Map<string, () => Promise<void>>();
    const calls: string[] = [];
    const child = fakeChild();
    child.kill = (signal: string) => calls.push(`kill:${signal}`);
    let markRestoreStarted: (() => void) | undefined;
    const restoreStarted = new Promise<void>((resolveStarted) => { markRestoreStarted = resolveStarted; });
    const running = runPackaging({
      rebuildElectron: async () => undefined,
      forge: async () => undefined,
      restoreHost: async (onSpawn?: (child: SpawnedChild) => void) => {
        onSpawn?.(child);
        calls.push('restore-started');
        markRestoreStarted?.();
        await new Promise<void>((resolveExit) => child.once('exit', () => resolveExit()));
        calls.push('restore-finished');
      },
      signalOptions: {
        on: (signal: string, handler: () => Promise<void>) => listeners.set(signal, handler),
        off: (signal: string) => listeners.delete(signal),
        exit: (code: number) => calls.push(`exit:${code}`),
      },
    });
    await restoreStarted;
    const interrupted = listeners.get('SIGTERM')?.();
    expect(calls).toEqual(['restore-started']);
    child.emit('exit', 0, null);
    await interrupted;
    await running;
    expect(calls).toEqual(['restore-started', 'restore-finished', 'exit:143']);
    expect(listeners.size).toBe(0);
  });

  it('restores after Forge failure', async () => {
    const calls: string[] = [];
    await expect(runPackaging({
      rebuildElectron: async () => { calls.push('rebuild'); },
      forge: async () => { calls.push('forge'); throw new Error('forge'); },
      restoreHost: async () => { calls.push('restore'); },
    })).rejects.toThrow('forge');
    expect(calls).toEqual(['rebuild', 'forge', 'restore']);
  });

  it('fails when host restoration fails after a successful package', async () => {
    await expect(runPackaging({
      rebuildElectron: async () => undefined,
      forge: async () => undefined,
      restoreHost: async () => { throw new Error('restore'); },
    })).rejects.toThrow('restore');
  });

  it('preserves a safe primary failure when packaging and restoration both fail', async () => {
    await expect(runPackaging({
      rebuildElectron: async () => undefined,
      forge: async () => { throw new Error('forge'); },
      restoreHost: async () => { throw new Error('restore'); },
    })).rejects.toThrow('Catbots packaging and host ABI restoration failed');
  });
});
