import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import type { ChildProcess } from 'node:child_process';
import { access, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { cleanupApplication } from './cleanup';

type LifecycleTestSeam = Readonly<{
  openMainWindow(): Promise<void>;
  requestQuit(response: number): Promise<void>;
}>;

async function packagedExecutable(): Promise<string> {
  const executable = join(resolve('apps/desktop/out'), `Catbots-darwin-${process.arch}`, 'Catbots.app', 'Contents', 'MacOS', 'Catbots');
  await access(executable);
  return executable;
}

async function waitForExit(child: ChildProcess, timeoutMs = 10_000): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise((resolveExit) => {
    const timeout = setTimeout(() => {
      child.off('exit', onExit);
      resolveExit(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timeout);
      resolveExit(true);
    };
    child.once('exit', onExit);
  });
}

test('packaged native shell keeps its owner alive after close and confirms quit', async () => {
  test.setTimeout(30_000);
  const dataDirectory = await mkdtemp(join(await realpath(tmpdir()), 'catbots-e2e-'));
  let app: ElectronApplication | undefined;
  let child: ChildProcess | undefined;
  try {
    app = await electron.launch({
      executablePath: await packagedExecutable(),
      args: ['--serve-web'],
      env: {
        ...process.env,
        CATBOTS_E2E_DATA_DIR: dataDirectory,
        CATBOTS_E2E_NATIVE: '1',
        NODE_ENV: 'test',
      },
    });
    child = app.process();
    const first = await app.firstWindow();
    await expect(first.getByRole('heading', { name: 'Connect your AI provider' })).toBeVisible();

    await first.close();
    await expect.poll(async () => (await app!.windows()).length).toBe(0);
    expect(child.exitCode).toBeNull();

    const reopenedPromise = app.waitForEvent('window');
    await app.evaluate(async () => {
      const lifecycle = (globalThis as typeof globalThis & { __catbotsE2E?: LifecycleTestSeam }).__catbotsE2E;
      if (lifecycle === undefined) throw new Error('E2E lifecycle seam unavailable');
      await lifecycle.openMainWindow();
    });
    const reopened = await reopenedPromise;
    await expect(reopened.getByRole('heading', { name: 'Connect your AI provider' })).toBeVisible();

    await app.evaluate(async () => {
      const lifecycle = (globalThis as typeof globalThis & { __catbotsE2E?: LifecycleTestSeam }).__catbotsE2E;
      if (lifecycle === undefined) throw new Error('E2E lifecycle seam unavailable');
      await lifecycle.requestQuit(1);
    });
    expect(child.exitCode).toBeNull();

    const quit = app.evaluate(async () => {
      const lifecycle = (globalThis as typeof globalThis & { __catbotsE2E?: LifecycleTestSeam }).__catbotsE2E;
      if (lifecycle === undefined) throw new Error('E2E lifecycle seam unavailable');
      await lifecycle.requestQuit(0);
    });
    expect(await waitForExit(child)).toBe(true);
    await quit.catch(() => undefined);
    expect(child.exitCode).toBe(0);
  } finally {
    await cleanupApplication({
      app,
      dataDirectory,
      process: child,
      removeDirectory: async (directory) => rm(directory, { recursive: true, force: true }),
      waitForExitWithin: waitForExit,
    });
  }
});
